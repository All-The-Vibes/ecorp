//! Materialize verified handoffs before provider execution, without granting new path authority.
//! Aggregate bytes include JSON framing and escaping; directory alias scans are bounded and
//! fail closed. Failed or interrupted writes are preserved, never silently replaced on replay.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, Metadata, OpenOptions},
};
use crony_protocol::dependency_files::{
    MAX_DEPENDENCY_BYTES, MAX_DEPENDENCY_FILE_BYTES, MAX_DEPENDENCY_FILES, VerifiedDependencyFile,
    dependency_path_is_safe,
};
use sha2::{Digest, Sha256};

const MAX_DIRECTORY_ENTRIES: usize = 16_384;

pub fn materialize(
    workspace: &Path,
    files: &[VerifiedDependencyFile],
    write_scope: &[String],
) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    Prepared::new(workspace, files, write_scope)?.finish()
}

struct PayloadSize(usize);

impl Write for PayloadSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_DEPENDENCY_BYTES)
            .ok_or_else(|| io::Error::other("dependency payload exceeds aggregate byte limit"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn validate(files: &[VerifiedDependencyFile], write_scope: &[String]) -> Result<()> {
    ensure!(
        files.len() <= MAX_DEPENDENCY_FILES,
        "too many dependency files"
    );
    ensure!(
        write_scope
            .iter()
            .all(|scope| crony_domain::write_scope_is_valid(scope)),
        "invalid persisted dependency write scope"
    );
    let mut names = BTreeMap::<String, (String, bool)>::new();
    for file in files {
        ensure!(
            dependency_path_is_safe(&file.path),
            "unsafe dependency path"
        );
        ensure!(
            file.content.len() <= MAX_DEPENDENCY_FILE_BYTES,
            "dependency file exceeds byte limit"
        );
        ensure!(
            file.sha256.len() == 64
                && file
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && hex::encode(Sha256::digest(file.content.as_bytes())) == file.sha256,
            "dependency file digest does not match exact bytes"
        );
        ensure!(
            write_scope
                .iter()
                .any(|scope| crony_domain::write_scope_allows_path(scope, &file.path)),
            "dependency file is outside persisted write scope"
        );
        let mut prefix = String::new();
        let components: Vec<_> = file.path.split('/').collect();
        for (index, component) in components.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(component);
            let is_file = index + 1 == components.len();
            if let Some((spelling, was_file)) = names.get(&prefix.to_ascii_lowercase()) {
                ensure!(
                    spelling == &prefix && !was_file && !is_file,
                    "dependency paths contain duplicate, case alias, or file-directory conflict"
                );
            } else {
                names.insert(prefix.to_ascii_lowercase(), (prefix.clone(), is_file));
            }
        }
    }
    // Count the wire representation, including escapes, field names, paths and digests,
    // without allocating an unbounded serialized copy.
    serde_json::to_writer(PayloadSize(0), files).context("dependency payload byte limit")?;
    Ok(())
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt as WindowsMetadataExt;
        // Junctions and other reparse tags need not report themselves as symlinks.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

fn plain_directory(parent: &Dir, name: &Path) -> Result<Dir> {
    let before = parent.symlink_metadata(name)?;
    ensure!(
        before.is_dir() && !is_link(&before),
        "dependency ancestor is not a plain directory"
    );
    let dir = parent
        .open_dir_nofollow(name)
        .context("open dependency directory without following links")?;
    let opened = dir.dir_metadata()?;
    ensure!(
        opened.is_dir() && !is_link(&opened) && identity(&before) == identity(&opened),
        "dependency directory changed while opening"
    );
    Ok(dir)
}

struct Directory {
    handle: Dir,
    parent: Option<usize>,
    name: OsString,
}

struct InstalledFile {
    handle: File,
    parent: usize,
    payload_index: usize,
    name: String,
}

struct Prepared<'a> {
    files: &'a [VerifiedDependencyFile],
    directories: Vec<Directory>,
    workspace: usize,
    parents: BTreeMap<String, usize>,
    installed: Vec<InstalledFile>,
}

impl<'a> Prepared<'a> {
    fn new(
        workspace: &Path,
        files: &'a [VerifiedDependencyFile],
        write_scope: &[String],
    ) -> Result<Self> {
        validate(files, write_scope)?;
        let absolute = if workspace.is_absolute() {
            workspace.to_owned()
        } else {
            std::env::current_dir()?.join(workspace)
        };
        let mut anchor = PathBuf::new();
        let mut names = Vec::new();
        for component in absolute.components() {
            match component {
                Component::Prefix(_) | Component::RootDir if names.is_empty() => {
                    anchor.push(component);
                }
                Component::Normal(name) => names.push(name.to_owned()),
                Component::CurDir => {}
                _ => bail!("dependency workspace has an ambiguous root"),
            }
        }
        ensure!(
            anchor.is_absolute(),
            "dependency workspace must have a root"
        );
        let root = Dir::open_ambient_dir(&anchor, ambient_authority())?;
        ensure!(
            !is_link(&root.dir_metadata()?),
            "dependency workspace anchor is a reparse point"
        );
        let mut directories = vec![Directory {
            handle: root,
            parent: None,
            name: OsString::new(),
        }];
        // Even the trusted workspace path is opened one component at a time. On Windows,
        // cap-std directory handles also deny delete sharing, pinning these ancestors.
        for name in names {
            let parent = directories.len() - 1;
            let handle = plain_directory(&directories[parent].handle, Path::new(&name))?;
            directories.push(Directory {
                handle,
                parent: Some(parent),
                name,
            });
        }
        let workspace = directories.len() - 1;
        let mut prepared = Self {
            files,
            directories,
            workspace,
            parents: BTreeMap::from([(String::new(), workspace)]),
            installed: Vec::new(),
        };
        // Preflight every existing ancestor and destination before making any filesystem
        // changes. Retain both directory and existing-file capabilities for the write phase.
        for (index, file) in files.iter().enumerate() {
            if let Some(parent) = prepared.parent(&file.path, false)?
                && let Some(existing) = prepared.existing(parent, index)?
            {
                prepared.installed.push(existing);
            }
        }
        prepared.ensure_directories_stable()?;
        Ok(prepared)
    }

    fn ensure_directories_stable(&self) -> Result<()> {
        for directory in &self.directories {
            let Some(parent) = directory.parent else {
                continue;
            };
            let current =
                plain_directory(&self.directories[parent].handle, Path::new(&directory.name))?;
            ensure!(
                identity(&current.dir_metadata()?) == identity(&directory.handle.dir_metadata()?),
                "dependency directory was replaced"
            );
        }
        Ok(())
    }

    fn parent(&mut self, path: &str, create: bool) -> Result<Option<usize>> {
        let mut index = self.workspace;
        let mut prefix = String::new();
        let mut components = path.split('/').peekable();
        while let Some(name) = components.next() {
            if components.peek().is_none() {
                break;
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(name);
            if let Some(cached) = self.parents.get(&prefix) {
                index = *cached;
                continue;
            }
            let parent = &self.directories[index].handle;
            if entry(parent, name)?.is_none() {
                if !create {
                    return Ok(None);
                }
                match parent.create_dir(name) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error).context("create dependency parent directory"),
                }
                ensure!(
                    entry(parent, name)?.is_some(),
                    "dependency directory disappeared after creation"
                );
            }
            let handle = plain_directory(parent, Path::new(name))?;
            self.directories.push(Directory {
                handle,
                parent: Some(index),
                name: name.into(),
            });
            index = self.directories.len() - 1;
            self.parents.insert(prefix.clone(), index);
        }
        Ok(Some(index))
    }

    fn existing(&self, parent: usize, payload_index: usize) -> Result<Option<InstalledFile>> {
        let payload = &self.files[payload_index];
        let name = payload.path.rsplit('/').next().expect("validated path");
        let dir = &self.directories[parent].handle;
        let Some(metadata) = entry(dir, name)? else {
            return Ok(None);
        };
        regular(&metadata, payload.content.len())?;
        let mut file = InstalledFile {
            handle: dir.open_with(name, &file_options(false))?,
            parent,
            payload_index,
            name: name.to_owned(),
        };
        ensure!(
            identity(&metadata) == identity(&file.handle.metadata()?),
            "dependency destination changed while opening"
        );
        self.verify(&mut file)?;
        Ok(Some(file))
    }

    fn verify(&self, file: &mut InstalledFile) -> Result<()> {
        let expected = self.files[file.payload_index].content.as_bytes();
        let before = file.handle.metadata()?;
        regular(&before, expected.len())?;
        file.handle.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::with_capacity(expected.len());
        Read::by_ref(&mut file.handle)
            .take(MAX_DEPENDENCY_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes == expected,
            "existing dependency file differs from verified bytes"
        );
        let after = file.handle.metadata()?;
        regular(&after, expected.len())?;
        let named = entry(&self.directories[file.parent].handle, &file.name)?
            .context("dependency file disappeared")?;
        regular(&named, expected.len())?;
        ensure!(
            identity(&before) == identity(&after) && identity(&after) == identity(&named),
            "dependency file was replaced"
        );
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.ensure_directories_stable()?;
        let existing: BTreeSet<_> = self
            .installed
            .iter()
            .map(|file| file.payload_index)
            .collect();
        for (payload_index, payload) in self.files.iter().enumerate() {
            if existing.contains(&payload_index) {
                continue;
            }
            self.ensure_directories_stable()?;
            let parent = self
                .parent(&payload.path, true)?
                .context("dependency parent was not created")?;
            // A destination created since preflight is acceptable only if it independently
            // passes the same exact-byte, regular-file, single-link resume checks.
            if let Some(file) = self.existing(parent, payload_index)? {
                self.installed.push(file);
                continue;
            }
            let name = payload.path.rsplit('/').next().expect("validated path");
            let mut file = InstalledFile {
                handle: self.directories[parent]
                    .handle
                    .open_with(name, &file_options(true))
                    .context("exclusively create dependency file")?,
                parent,
                payload_index,
                name: name.to_owned(),
            };
            regular(&file.handle.metadata()?, 0)?;
            file.handle.write_all(payload.content.as_bytes())?;
            file.handle.sync_all()?;
            self.verify(&mut file)?;
            self.installed.push(file);
        }
        self.ensure_directories_stable()?;
        let mut installed = std::mem::take(&mut self.installed);
        for file in &mut installed {
            self.verify(file)?;
        }
        // Never delete or roll back on failure: an interrupted write remains visible and
        // requires reconciliation, rather than silently replacing unequal retained work.
        Ok(())
    }
}

fn entry(dir: &Dir, name: &str) -> Result<Option<Metadata>> {
    let mut exact = false;
    for (index, entry) in dir.entries()?.enumerate() {
        ensure!(
            index < MAX_DIRECTORY_ENTRIES,
            "dependency directory exceeds bounded alias-check limit"
        );
        let name_on_disk = entry?.file_name();
        if let Some(spelling) = name_on_disk.to_str()
            && spelling.eq_ignore_ascii_case(name)
        {
            ensure!(
                spelling == name,
                "dependency path aliases an existing entry"
            );
            exact = true;
        }
    }
    match dir.symlink_metadata(name) {
        Ok(metadata) => {
            ensure!(
                exact,
                "dependency entry changed or uses an alternate spelling"
            );
            ensure!(
                !is_link(&metadata),
                "dependency path is a link or reparse point"
            );
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && !exact => Ok(None),
        Err(error) => Err(error).context("inspect dependency entry"),
    }
}

fn regular(metadata: &Metadata, expected_size: usize) -> Result<()> {
    ensure!(
        metadata.is_file()
            && !is_link(metadata)
            && metadata.nlink() == 1
            && metadata.len() == expected_size as u64
            && metadata.len() <= MAX_DEPENDENCY_FILE_BYTES as u64,
        "dependency destination is not a bounded, single-link regular file of the expected size"
    );
    Ok(())
}

fn file_options(create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(create)
        .create_new(create)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // A regular-file-to-FIFO race must not hang runner admission.
        options.custom_flags(libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        // Retained files may be read, but not concurrently replaced or opened for writing.
        const FILE_SHARE_READ: u32 = 1;
        options.share_mode(FILE_SHARE_READ);
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        root: PathBuf,
        workspace: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(format!("dependency-files-{}", uuid::Uuid::new_v4()));
            let workspace = root.join("workspace");
            fs::create_dir_all(&workspace).expect("create owned fixture");
            Self { root, workspace }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).expect("remove owned dependency fixture");
        }
    }

    fn payload(path: &str, content: &str) -> VerifiedDependencyFile {
        VerifiedDependencyFile {
            path: path.to_owned(),
            sha256: hex::encode(Sha256::digest(content.as_bytes())),
            content: content.to_owned(),
        }
    }

    fn scope() -> Vec<String> {
        vec!["**".to_owned()]
    }

    fn assert_empty(workspace: &Path) {
        assert_eq!(fs::read_dir(workspace).unwrap().count(), 0);
    }

    #[test]
    fn exact_bytes_are_native_readable_and_replay_is_idempotent() {
        let fixture = Fixture::new();
        let files = [
            payload("handoffs/source.txt", "\u{feff}first\r\nλ\0last\n"),
            payload(
                "handoffs/nested/module.rs",
                "pub const READY: bool = true;\n",
            ),
        ];
        materialize(&fixture.workspace, &files, &["handoffs/**".to_owned()]).unwrap();
        let before = fs::metadata(fixture.workspace.join(&files[0].path))
            .unwrap()
            .modified()
            .unwrap();
        materialize(&fixture.workspace, &files, &["handoffs/**".to_owned()]).unwrap();
        for file in &files {
            assert_eq!(
                fs::read(fixture.workspace.join(&file.path)).unwrap(),
                file.content.as_bytes()
            );
        }
        assert_eq!(
            before,
            fs::metadata(fixture.workspace.join(&files[0].path))
                .unwrap()
                .modified()
                .unwrap()
        );
    }

    #[test]
    fn empty_assignment_is_a_noop_without_workspace_or_write_authority() {
        let fixture = Fixture::new();
        materialize(&fixture.root.join("absent"), &[], &[]).unwrap();
        assert!(!fixture.root.join("absent").exists());
    }

    #[test]
    fn correctly_attested_empty_file_is_materialized() {
        let fixture = Fixture::new();
        materialize(&fixture.workspace, &[payload("empty.txt", "")], &scope()).unwrap();
        assert_eq!(fs::read(fixture.workspace.join("empty.txt")).unwrap(), b"");
    }

    #[test]
    fn altered_missing_and_noncanonical_digests_fail_before_writes() {
        let fixture = Fixture::new();
        let original = payload("second.txt", "original\n");
        let mut cases = vec![
            VerifiedDependencyFile {
                content: "altered\n".into(),
                ..original.clone()
            },
            VerifiedDependencyFile {
                content: String::new(),
                ..original.clone()
            },
            VerifiedDependencyFile {
                sha256: String::new(),
                ..original.clone()
            },
            VerifiedDependencyFile {
                sha256: original.sha256.to_uppercase(),
                ..original.clone()
            },
            VerifiedDependencyFile {
                sha256: "g".repeat(64),
                ..original.clone()
            },
            VerifiedDependencyFile {
                sha256: "0".repeat(63),
                ..original.clone()
            },
        ];
        cases.push(VerifiedDependencyFile {
            content: "original\r\n".into(),
            ..original
        });
        for invalid in cases {
            assert!(
                materialize(
                    &fixture.workspace,
                    &[payload("first.txt", "must not appear"), invalid],
                    &scope(),
                )
                .is_err()
            );
            assert_empty(&fixture.workspace);
        }
    }

    #[test]
    fn unsafe_paths_fail_before_writes() {
        let fixture = Fixture::new();
        for path in [
            "",
            "../escape",
            "/absolute",
            "C:/escape",
            "a\\b",
            "a//b",
            "./x",
            "a/../x",
            ".git/config",
            "a/.env",
            "NUL.txt",
            "file:stream",
            "dir./file",
            "dir /file",
            "file~1.txt",
            "credentials.json",
            "a/*.txt",
        ] {
            assert!(
                materialize(&fixture.workspace, &[payload(path, "x")], &scope()).is_err(),
                "{path}"
            );
            assert_empty(&fixture.workspace);
        }
    }

    #[test]
    fn persisted_scope_is_required_and_cannot_be_widened() {
        let fixture = Fixture::new();
        for allowed in [
            vec![],
            vec!["elsewhere/**".into()],
            vec!["handoffs".into()],
            vec!["../**".into()],
        ] {
            assert!(
                materialize(
                    &fixture.workspace,
                    &[payload("handoffs/source.txt", "source")],
                    &allowed,
                )
                .is_err()
            );
            assert_empty(&fixture.workspace);
        }
        materialize(
            &fixture.workspace,
            &[payload("handoffs/source.txt", "source")],
            &["handoffs/source.txt".into()],
        )
        .unwrap();
    }

    #[test]
    fn all_out_of_scope_files_are_checked_before_writes() {
        let fixture = Fixture::new();
        assert!(
            materialize(
                &fixture.workspace,
                &[payload("allowed/a", "a"), payload("outside/b", "b")],
                &["allowed/**".into()],
            )
            .is_err()
        );
        assert_empty(&fixture.workspace);
    }

    #[test]
    fn file_count_and_per_file_byte_limits_are_enforced() {
        let fixture = Fixture::new();
        let files: Vec<_> = (0..=MAX_DEPENDENCY_FILES)
            .map(|index| payload(&format!("file{index}.txt"), "x"))
            .collect();
        assert!(materialize(&fixture.workspace, &files, &scope()).is_err());
        assert!(
            materialize(
                &fixture.workspace,
                &[payload(
                    "large.txt",
                    &"λ".repeat(MAX_DEPENDENCY_FILE_BYTES / 2 + 1)
                )],
                &scope(),
            )
            .is_err()
        );
        assert_empty(&fixture.workspace);
        materialize(
            &fixture.workspace,
            &[payload("limit.txt", &"x".repeat(MAX_DEPENDENCY_FILE_BYTES))],
            &scope(),
        )
        .unwrap();
    }

    #[test]
    fn aggregate_limit_includes_paths_digests_framing_and_escaping() {
        let fixture = Fixture::new();
        let files: Vec<_> = (0..MAX_DEPENDENCY_FILES)
            .map(|index| {
                payload(
                    &format!("file{index}.txt"),
                    &"x".repeat(MAX_DEPENDENCY_BYTES / MAX_DEPENDENCY_FILES),
                )
            })
            .collect();
        assert_eq!(
            files.iter().map(|file| file.content.len()).sum::<usize>(),
            MAX_DEPENDENCY_BYTES
        );
        assert!(materialize(&fixture.workspace, &files, &scope()).is_err());
        let escaped: Vec<_> = (0..2)
            .map(|index| {
                payload(
                    &format!("escaped{index}.txt"),
                    &"\0".repeat(MAX_DEPENDENCY_FILE_BYTES),
                )
            })
            .collect();
        assert!(materialize(&fixture.workspace, &escaped, &scope()).is_err());
        assert_empty(&fixture.workspace);
    }

    #[test]
    fn aggregate_counter_fails_closed_on_arithmetic_overflow() {
        let mut counter = PayloadSize(usize::MAX);
        assert!(counter.write(b"x").is_err());
        let mut counter = PayloadSize(MAX_DEPENDENCY_BYTES);
        assert!(counter.write(b"x").is_err());
    }

    #[test]
    fn exact_aggregate_boundary_is_accepted_and_next_byte_rejected() {
        let fixture = Fixture::new();
        let mut files: Vec<_> = (0..6)
            .map(|index| payload(&format!("file{index}.txt"), &"x".repeat(10_000)))
            .collect();
        let remaining = MAX_DEPENDENCY_BYTES - serde_json::to_vec(&files).unwrap().len();
        files.push(payload("last.txt", ""));
        let overhead =
            serde_json::to_vec(&files).unwrap().len() - (MAX_DEPENDENCY_BYTES - remaining);
        files.last_mut().unwrap().content = "x".repeat(remaining - overhead);
        files.last_mut().unwrap().sha256 =
            hex::encode(Sha256::digest(files.last().unwrap().content.as_bytes()));
        assert_eq!(
            serde_json::to_vec(&files).unwrap().len(),
            MAX_DEPENDENCY_BYTES
        );
        materialize(&fixture.workspace, &files, &scope()).unwrap();
        files.last_mut().unwrap().content.push('x');
        files.last_mut().unwrap().sha256 =
            hex::encode(Sha256::digest(files.last().unwrap().content.as_bytes()));
        assert!(validate(&files, &scope()).is_err());
    }

    #[test]
    fn duplicate_alias_and_file_directory_conflicts_are_rejected() {
        let fixture = Fixture::new();
        for paths in [
            ["same.txt", "same.txt"],
            ["Same.txt", "same.txt"],
            ["Directory/one.txt", "directory/two.txt"],
            ["entry", "entry/child"],
            ["entry/child", "entry"],
            ["ENTRY", "entry/child"],
        ] {
            let files = paths.map(|path| payload(path, "x"));
            assert!(
                materialize(&fixture.workspace, &files, &scope()).is_err(),
                "{paths:?}"
            );
            assert_empty(&fixture.workspace);
        }
    }

    #[test]
    fn existing_unequal_or_truncated_files_are_never_overwritten() {
        let fixture = Fixture::new();
        for content in ["modified", "", "original-and-extra"] {
            fs::write(fixture.workspace.join("retained.txt"), content).unwrap();
            assert!(
                materialize(
                    &fixture.workspace,
                    &[
                        payload("new.txt", "must not appear"),
                        payload("retained.txt", "original")
                    ],
                    &scope(),
                )
                .is_err()
            );
            assert!(!fixture.workspace.join("new.txt").exists());
            assert_eq!(
                fs::read(fixture.workspace.join("retained.txt")).unwrap(),
                content.as_bytes()
            );
        }
    }

    #[test]
    fn oversized_existing_files_are_rejected_without_reading_them() {
        let fixture = Fixture::new();
        let path = fixture.workspace.join("large.txt");
        let oversized = MAX_DEPENDENCY_FILE_BYTES as u64 * 1024;
        fs::File::create(&path).unwrap().set_len(oversized).unwrap();
        assert!(materialize(&fixture.workspace, &[payload("large.txt", "x")], &scope()).is_err());
        assert_eq!(fs::metadata(path).unwrap().len(), oversized);
    }

    #[test]
    fn existing_directory_and_file_ancestors_fail_preflight() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.workspace.join("directory")).unwrap();
        fs::write(fixture.workspace.join("file"), "retained").unwrap();
        for path in ["directory", "file/child"] {
            assert!(
                materialize(
                    &fixture.workspace,
                    &[payload("new.txt", "must not appear"), payload(path, "x")],
                    &scope(),
                )
                .is_err()
            );
            assert!(!fixture.workspace.join("new.txt").exists());
        }
        assert_eq!(
            fs::read(fixture.workspace.join("file")).unwrap(),
            b"retained"
        );
    }

    #[test]
    fn existing_case_aliases_fail_on_every_platform() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.workspace.join("Directory")).unwrap();
        fs::write(fixture.workspace.join("Existing.txt"), "same").unwrap();
        for path in ["directory/new.txt", "existing.txt"] {
            assert!(materialize(&fixture.workspace, &[payload(path, "same")], &scope()).is_err());
        }
        assert_eq!(
            fs::read_dir(fixture.workspace.join("Directory"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn exact_existing_hardlinks_are_rejected_without_touching_either_name() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside.txt");
        fs::write(&outside, "same").unwrap();
        fs::hard_link(&outside, fixture.workspace.join("linked.txt")).unwrap();
        assert!(
            materialize(
                &fixture.workspace,
                &[payload("first.txt", "new"), payload("linked.txt", "same")],
                &scope(),
            )
            .is_err()
        );
        assert!(!fixture.workspace.join("first.txt").exists());
        assert_eq!(fs::read(outside).unwrap(), b"same");
    }

    #[test]
    fn unequal_file_appearing_after_preflight_preserves_partial_results() {
        let fixture = Fixture::new();
        let files = [
            payload("first.txt", "verified"),
            payload("second.txt", "verified"),
        ];
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        fs::write(fixture.workspace.join("second.txt"), "retained").unwrap();
        assert!(prepared.finish().is_err());
        assert_eq!(
            fs::read(fixture.workspace.join("first.txt")).unwrap(),
            b"verified"
        );
        assert_eq!(
            fs::read(fixture.workspace.join("second.txt")).unwrap(),
            b"retained"
        );
        assert!(materialize(&fixture.workspace, &files, &scope()).is_err());
        assert_eq!(
            fs::read(fixture.workspace.join("first.txt")).unwrap(),
            b"verified"
        );
    }

    #[test]
    fn exact_file_appearing_after_preflight_is_safe_to_adopt() {
        let fixture = Fixture::new();
        let files = [payload("result.txt", "verified")];
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        fs::write(fixture.workspace.join("result.txt"), "verified").unwrap();
        prepared.finish().unwrap();
        assert_eq!(
            fs::read(fixture.workspace.join("result.txt")).unwrap(),
            b"verified"
        );
    }

    #[test]
    fn hardlink_appearing_after_preflight_cannot_be_adopted() {
        let fixture = Fixture::new();
        let files = [payload("result.txt", "verified")];
        let outside = fixture.root.join("outside.txt");
        fs::write(&outside, "verified").unwrap();
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        fs::hard_link(&outside, fixture.workspace.join("result.txt")).unwrap();
        assert!(prepared.finish().is_err());
        assert_eq!(fs::read(outside).unwrap(), b"verified");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_destinations_and_ancestors_are_rejected_before_writes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("target.txt"), "same").unwrap();
        symlink(&outside, fixture.workspace.join("linked-dir")).unwrap();
        symlink(
            outside.join("target.txt"),
            fixture.workspace.join("linked-file"),
        )
        .unwrap();
        symlink(outside.join("absent"), fixture.workspace.join("dangling")).unwrap();
        for path in ["linked-dir/new.txt", "linked-file", "dangling"] {
            assert!(
                materialize(
                    &fixture.workspace,
                    &[payload("first.txt", "new"), payload(path, "same")],
                    &scope(),
                )
                .is_err()
            );
            assert!(!fixture.workspace.join("first.txt").exists());
        }
        assert_eq!(fs::read(outside.join("target.txt")).unwrap(), b"same");
        assert!(!outside.join("new.txt").exists());
        assert!(!outside.join("absent").exists());
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlink_swap_after_preflight_cannot_redirect_writes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let parent = fixture.workspace.join("parent");
        let moved = fixture.workspace.join("moved");
        let outside = fixture.root.join("outside");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&outside).unwrap();
        let files = [payload("parent/new.txt", "verified")];
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        fs::rename(&parent, &moved).unwrap();
        symlink(&outside, &parent).unwrap();
        assert!(prepared.finish().is_err());
        assert!(!outside.join("new.txt").exists());
        assert!(!moved.join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_symlinks_and_late_file_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let files = [payload("result.txt", "verified")];
        let workspace_alias = fixture.root.join("alias");
        symlink(&fixture.workspace, &workspace_alias).unwrap();
        assert!(materialize(&workspace_alias, &files, &scope()).is_err());
        let outside = fixture.root.join("outside.txt");
        fs::write(&outside, "retained").unwrap();
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        symlink(&outside, fixture.workspace.join("result.txt")).unwrap();
        assert!(prepared.finish().is_err());
        assert_eq!(fs::read(outside).unwrap(), b"retained");
    }

    #[cfg(unix)]
    #[test]
    fn fifo_destination_is_rejected_without_blocking() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let fixture = Fixture::new();
        let path = fixture.workspace.join("fifo");
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        // The owned fixture path is NUL-terminated and valid for this call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        assert!(materialize(&fixture.workspace, &[payload("fifo", "x")], &scope()).is_err());
    }

    #[cfg(windows)]
    fn junction(target: &Path, link: &Path) {
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg("New-Item -ItemType Junction -Path $env:CRONY_TEST_LINK -Target $env:CRONY_TEST_TARGET -ErrorAction Stop | Out-Null")
            .env("CRONY_TEST_LINK", link)
            .env("CRONY_TEST_TARGET", target)
            .status()
            .expect("execute junction fixture creation");
        assert!(
            status.success(),
            "junction fixture must be created, not skipped"
        );
    }

    #[cfg(windows)]
    #[test]
    fn junction_ancestors_and_workspace_roots_are_rejected_before_writes() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        let link = fixture.workspace.join("junction");
        junction(&outside, &link);
        for path in ["junction/new.txt", "junction"] {
            assert!(
                materialize(
                    &fixture.workspace,
                    &[payload("first.txt", "new"), payload(path, "verified")],
                    &scope(),
                )
                .is_err()
            );
            assert!(!fixture.workspace.join("first.txt").exists());
        }
        assert!(materialize(&link, &[payload("new.txt", "verified")], &scope()).is_err());
        assert_empty(&outside);
        fs::remove_dir(link).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retained_directory_capabilities_prevent_windows_parent_replacement() {
        let fixture = Fixture::new();
        let parent = fixture.workspace.join("parent");
        fs::create_dir(&parent).unwrap();
        let files = [payload("parent/new.txt", "verified")];
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        assert!(fs::rename(&parent, fixture.workspace.join("moved")).is_err());
        assert!(fs::remove_dir(&parent).is_err());
        prepared.finish().unwrap();
        assert_eq!(fs::read(parent.join("new.txt")).unwrap(), b"verified");
    }

    #[cfg(windows)]
    #[test]
    fn retained_exact_files_deny_concurrent_windows_writes_and_replacement() {
        let fixture = Fixture::new();
        let path = fixture.workspace.join("result.txt");
        fs::write(&path, "verified").unwrap();
        let files = [payload("result.txt", "verified")];
        let prepared = Prepared::new(&fixture.workspace, &files, &scope()).unwrap();
        assert!(fs::write(&path, "tampered").is_err());
        assert!(fs::remove_file(&path).is_err());
        prepared.finish().unwrap();
        assert_eq!(fs::read(path).unwrap(), b"verified");
    }
}
