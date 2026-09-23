//! Read-only evidence scanning through the repository's pinned capability I/O.
//! Node has no portable directory-relative open API. cap-std 4.0.3 supplies
//! relative no-follow opens, but Windows enumeration recovers a pathname. The
//! Windows adapter below enumerates the held handle instead. Read sharing also
//! fences data writers and deletion; attribute-only handles are not a write fence.
use std::{
    ffi::{OsStr, OsString},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

use anyhow::{Result, bail, ensure};
use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use serde::Deserialize;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;
const REGULAR: &str = "Evidence path check requires regular files and directories";

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .maybe_dir(true)
        .follow(FollowSymlinks::No);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        // FILE_SHARE_READ fences data writers and replacement. Reparse updates
        // can use attribute-only rights, so enumeration must still use a handle.
        options.share_mode(1);
    }
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options
}

fn plain(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt as WindowsMetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink() && (metadata.is_file() || metadata.is_dir())
}

fn open_entry(parent: &Dir, name: &OsStr) -> Result<File> {
    ensure!(plain(&parent.dir_metadata()?), "{REGULAR}");
    let file = parent.open_with(name, &options())?;
    ensure!(plain(&file.metadata()?), "{REGULAR}");
    Ok(file)
}

fn same_identity(a: &Metadata, b: &Metadata) -> bool {
    plain(b) && a.dev() == b.dev() && a.ino() == b.ino() && a.is_dir() == b.is_dir()
}

fn same_change_time(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt as UnixMetadataExt;
        a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        // Windows acquisition denies existing and future writers. POSIX has no
        // equivalent sharing fence, so it also checks ctime after content reads.
        let _ = (a, b);
        true
    }
}

fn ensure_named(parent: &Dir, name: &OsStr, expected: &Metadata) -> Result<()> {
    let named = open_entry(parent, name)?.metadata()?;
    ensure!(
        same_identity(expected, &named),
        "{REGULAR}; entry changed during scan"
    );
    Ok(())
}

struct Root {
    // Holding all components also fences ancestor replacement on Windows.
    chain: Vec<Dir>,
    names: Vec<std::ffi::OsString>,
    path: PathBuf,
}

impl Root {
    fn open(path: &Path) -> Result<Self> {
        ensure!(path.is_absolute(), "Evidence roots must be absolute");
        let mut anchor = PathBuf::new();
        let mut names = Vec::new();
        for component in path.components() {
            match component {
                Component::Prefix(_) | Component::RootDir if names.is_empty() => {
                    anchor.push(component)
                }
                Component::Normal(name) => names.push(name.to_owned()),
                _ => bail!("{REGULAR}"),
            }
        }
        let mut ambient = std::fs::OpenOptions::new();
        ambient.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // BACKUP_SEMANTICS | OPEN_REPARSE_POINT, with read-only sharing.
            ambient
                .custom_flags(0x0200_0000 | 0x0020_0000)
                .share_mode(1);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            ambient.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let first = Dir::from_std_file(ambient.open(anchor)?);
        ensure!(plain(&first.dir_metadata()?), "{REGULAR}");
        let mut chain = vec![first];
        for name in &names {
            let file = open_entry(chain.last().expect("root handle"), name)?;
            ensure!(file.metadata()?.is_dir(), "{REGULAR}");
            chain.push(Dir::from_std_file(file.into_std()));
        }
        Ok(Self {
            chain,
            names,
            path: path.to_owned(),
        })
    }

    fn dir(&self) -> &Dir {
        self.chain.last().expect("root handle")
    }

    fn unchanged(&self) -> Result<()> {
        for (index, name) in self.names.iter().enumerate() {
            ensure_named(
                &self.chain[index],
                name,
                &self.chain[index + 1].dir_metadata()?,
            )?;
        }
        Ok(())
    }
}

fn has_personal_path(text: &str) -> bool {
    text.char_indices().any(|(index, character)| {
        if !matches!(character, '/' | '\\') {
            return false;
        }
        let value = text[index..].trim_start_matches(['/', '\\']);
        let Some(prefix) = value.get(..5) else {
            return false;
        };
        if !prefix.eq_ignore_ascii_case("Users") {
            return false;
        }
        let rest = &value[5..];
        if !rest.starts_with(['/', '\\']) {
            return false;
        }
        rest.trim_start_matches(['/', '\\'])
            .chars()
            .next()
            .is_some_and(|next|
            // Match JavaScript's \s exactly, including BOM but excluding NEL.
            !matches!(next, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                '\u{205f}' | '\u{3000}' | '\u{feff}' | '/' | '\\' | '"' | '\'' | '<' | '>'))
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    DirectoryHeld,
    FileHeld,
}

#[cfg(not(windows))]
fn child_names(directory: &Dir, maximum: usize) -> Result<Vec<OsString>> {
    let mut names = Vec::new();
    for entry in directory.entries()? {
        ensure!(names.len() < maximum, "Evidence entry count exceeds limit");
        names.push(entry?.file_name());
    }
    Ok(names)
}

#[cfg(windows)]
fn child_names(directory: &Dir, maximum: usize) -> Result<Vec<OsString>> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::ERROR_NO_MORE_FILES,
        Storage::FileSystem::{
            FILE_ID_BOTH_DIR_INFO, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
            GetFileInformationByHandleEx,
        },
    };
    let mut buffer = vec![0u64; 8192];
    let bytes = buffer.len() * size_of::<u64>();
    let header = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
    let mut class = FileIdBothDirectoryRestartInfo;
    let mut names = Vec::new();
    loop {
        // SAFETY: the retained directory handle and aligned, initialized 64 KiB
        // buffer live throughout this synchronous Windows directory query.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                bytes as u32,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error.into());
        }
        class = FileIdBothDirectoryInfo;
        let mut offset = 0;
        loop {
            ensure!(
                offset + size_of::<FILE_ID_BOTH_DIR_INFO>() <= bytes,
                "Invalid directory record"
            );
            // SAFETY: the header is wholly inside the initialized buffer. Windows
            // owns record layout; lengths and offsets are bounded before use.
            let row = unsafe {
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFO>()
                    .read_unaligned()
            };
            let length = row.FileNameLength as usize;
            ensure!(
                length > 0 && length.is_multiple_of(2) && offset + header + length <= bytes,
                "Invalid directory name"
            );
            // SAFETY: the checked even-sized UTF-16 span is in this aligned buffer.
            let name = unsafe {
                OsString::from_wide(std::slice::from_raw_parts(
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset + header)
                        .cast::<u16>(),
                    length / 2,
                ))
            };
            if name != OsStr::new(".") && name != OsStr::new("..") {
                ensure!(names.len() < maximum, "Evidence entry count exceeds limit");
                ensure!(
                    Path::new(&name).components().count() == 1
                        && matches!(
                            Path::new(&name).components().next(),
                            Some(Component::Normal(_))
                        ),
                    "Invalid directory name"
                );
                names.push(name);
            }
            if row.NextEntryOffset == 0 {
                break;
            }
            let next = row.NextEntryOffset as usize;
            ensure!(
                next >= header + length && next.is_multiple_of(8) && offset + next < bytes,
                "Invalid directory offset"
            );
            offset += next;
        }
    }
    Ok(names)
}

fn visit(
    directory: &Dir,
    relative: &Path,
    findings: &mut Vec<String>,
    entries: &mut usize,
    hook: &mut impl FnMut(Stage, &Path, Option<&File>),
) -> Result<()> {
    ensure!(
        relative.components().count() <= 64,
        "Evidence directory depth exceeds limit"
    );
    hook(Stage::DirectoryHeld, relative, None);
    ensure!(plain(&directory.dir_metadata()?), "{REGULAR}");
    for name in child_names(directory, MAX_ENTRIES.saturating_sub(*entries))? {
        *entries += 1;
        ensure!(
            *entries <= MAX_ENTRIES,
            "Evidence entry count exceeds limit"
        );
        let mut file = open_entry(directory, &name)?;
        let before = file.metadata()?;
        let location = relative.join(&name);
        if before.is_dir() {
            let child = Dir::from_std_file(file.into_std());
            visit(&child, &location, findings, entries, hook)?;
            ensure_named(directory, &name, &before)?;
        } else {
            ensure!(before.nlink() == 1, "{REGULAR}");
            ensure!(
                before.len() <= MAX_FILE_BYTES,
                "Evidence file exceeds byte limit"
            );
            hook(Stage::FileHeld, &location, Some(&file));
            ensure_named(directory, &name, &before)?;
            let mut bytes = Vec::with_capacity(before.len() as usize + 1);
            (&mut file).take(before.len() + 1).read_to_end(&mut bytes)?;
            let after = file.metadata()?;
            ensure!(
                same_identity(&before, &after)
                    && after.nlink() == 1
                    && after.len() == before.len()
                    && after.modified()? == before.modified()?
                    && same_change_time(&before, &after)
                    && bytes.len() as u64 == before.len(),
                "Evidence file changed during scan"
            );
            ensure_named(directory, &name, &before)?;
            if has_personal_path(&String::from_utf8_lossy(&bytes)) {
                findings.push(location.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

fn packet_name(name: &str) -> bool {
    matches!(
        name,
        "pr226-integration-20260921" | "pr226-local-validation"
    ) || name.starts_with("pr-226-completion-")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(default)]
    directories: Vec<PathBuf>,
    discover: Option<PathBuf>,
    #[serde(default)]
    inventory_only: bool,
}

fn scan(request: Request) -> Result<serde_json::Value> {
    ensure!(request.directories.len() <= 128, "Too many evidence roots");
    let mut roots = Vec::new();
    let mut findings = Vec::new();
    let mut entries = 0;
    let mut hook = |_, _: &Path, _: Option<&File>| {};
    if let Some(parent) = request.discover {
        ensure!(
            request.directories.is_empty(),
            "Choose explicit roots or discovery"
        );
        let root = Root::open(&parent)?;
        for name in child_names(root.dir(), MAX_ENTRIES)? {
            entries += 1;
            ensure!(entries <= MAX_ENTRIES, "Evidence entry count exceeds limit");
            if !name.to_str().is_some_and(packet_name) {
                continue;
            }
            let file = open_entry(root.dir(), &name)?;
            let metadata = file.metadata()?;
            ensure!(metadata.is_dir(), "{REGULAR}");
            let directory = Dir::from_std_file(file.into_std());
            roots.push(parent.join(&name));
            if !request.inventory_only {
                visit(
                    &directory,
                    Path::new(&name),
                    &mut findings,
                    &mut entries,
                    &mut hook,
                )?;
            }
            ensure_named(root.dir(), &name, &metadata)?;
        }
        ensure!(!roots.is_empty(), "No PR226 evidence packets found");
        root.unchanged()?;
    } else {
        ensure!(
            !request.directories.is_empty(),
            "At least one evidence root is required"
        );
        for path in request.directories {
            let root = Root::open(&path)?;
            let name = root
                .path
                .file_name()
                .ok_or_else(|| anyhow::anyhow!("Evidence root needs a name"))?;
            if !request.inventory_only {
                visit(
                    root.dir(),
                    Path::new(name),
                    &mut findings,
                    &mut entries,
                    &mut hook,
                )?;
            }
            root.unchanged()?;
            roots.push(path);
        }
    }
    roots.sort();
    findings.sort();
    Ok(serde_json::json!({"directories": roots, "files": findings}))
}

fn run() -> Result<()> {
    let mut input = Vec::new();
    io::stdin().take(1024 * 1024 + 1).read_to_end(&mut input)?;
    ensure!(input.len() <= 1024 * 1024, "Evidence request exceeds limit");
    let request: Request = serde_json::from_slice(&input)?;
    println!("{}", scan(request)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{REGULAR}; {error}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("ecorp-evidence-native-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            // macOS /var is an alias; the fixture itself is owned and canonical.
            Self(fs::canonicalize(root).unwrap())
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Keep failed or unverifiable fixtures for diagnosis, and never
            // turn an assertion failure into an abort by panicking twice.
            if !std::thread::panicking()
                && let Err(error) = fs::remove_dir_all(&self.0)
            {
                eprintln!("Owned native fixture retained after cleanup failure: {error}");
            }
        }
    }

    fn scan_with_hook(
        path: &Path,
        hook: &mut impl FnMut(Stage, &Path, Option<&File>),
    ) -> Result<Vec<String>> {
        let root = Root::open(path)?;
        let mut findings = Vec::new();
        visit(root.dir(), Path::new("packet"), &mut findings, &mut 0, hook)?;
        root.unchanged()?;
        Ok(findings)
    }

    #[test]
    fn detector_matches_javascript_whitespace_and_path_variants() {
        for value in [
            r"\Users\fixture-user",
            r"D:\\Users\\fixture-user",
            r"c:\uSeRs/fixture-user",
            "/Users/fixture-user",
            "d:/users/fixture-user/source",
            "/Users/\u{85}name",
        ] {
            assert!(has_personal_path(value), "{value:?}");
        }
        for value in [
            "<original-user>",
            "<local-user>/source",
            r"C:\Users\<original-user>\source",
            "Users can review evidence.",
            "source/users.test.mjs",
            "C:/Users/",
            "/Users/\u{feff}name",
            "/Users/\u{a0}name",
            "/Users/\u{2003}name",
        ] {
            assert!(!has_personal_path(value), "{value:?}");
        }
    }

    #[test]
    fn bounded_scan_reports_names_and_never_personal_values() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("nested")).unwrap();
        fs::write(
            fixture.path("nested/receipt.json"),
            r#"{"home":"\Users\fixture-user"}"#,
        )
        .unwrap();
        fs::write(fixture.path("safe.txt"), "<local-user>").unwrap();
        let findings = scan_with_hook(&fixture.0, &mut |_, _, _| {}).unwrap();
        assert_eq!(findings, ["packet/nested/receipt.json"]);
        assert!(!findings.join(" ").contains("fixture-user"));
    }

    #[test]
    fn oversized_files_are_refused_before_the_read_window() {
        let fixture = Fixture::new();
        fs::File::create(fixture.path("large.bin"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let mut reads = 0;
        let result = scan_with_hook(&fixture.0, &mut |stage, _, _| {
            if stage == Stage::FileHeld {
                reads += 1;
            }
        });
        assert!(result.unwrap_err().to_string().contains("byte limit"));
        assert_eq!(reads, 0);
    }

    #[test]
    fn empty_files_and_exact_byte_limit_are_accepted() {
        let fixture = Fixture::new();
        fs::File::create(fixture.path("boundary.bin"))
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
        fs::write(fixture.path("empty.txt"), []).unwrap();
        assert!(
            scan_with_hook(&fixture.0, &mut |_, _, _| {})
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn hard_links_are_refused_before_the_read_window() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("packet")).unwrap();
        fs::write(fixture.path("outside.txt"), "outside fixture").unwrap();
        fs::hard_link(
            fixture.path("outside.txt"),
            fixture.path("packet/alias.txt"),
        )
        .unwrap();
        let mut reads = 0;
        assert!(
            scan_with_hook(&fixture.path("packet"), &mut |stage, _, _| {
                if stage == Stage::FileHeld {
                    reads += 1;
                }
            })
            .is_err()
        );
        assert_eq!(reads, 0);
    }

    fn file_replacement(link: bool) {
        let fixture = Fixture::new();
        fs::create_dir(fixture.path("packet")).unwrap();
        let target = fixture.path("packet/inside.txt");
        let outside = fixture.path("outside.txt");
        fs::write(&target, "inside bytes").unwrap();
        fs::write(&outside, r"\Users\outside-must-never-be-read").unwrap();
        let outside_metadata = File::from_std(fs::File::open(&outside).unwrap())
            .metadata()
            .unwrap();
        let mut attempted = false;
        let result = scan_with_hook(&fixture.path("packet"), &mut |stage, _, file| {
            if stage != Stage::FileHeld {
                return;
            }
            assert!(!same_identity(
                &outside_metadata,
                &file.unwrap().metadata().unwrap()
            ));
            assert!(!attempted);
            attempted = true;
            let replaced = fs::rename(&target, fixture.path("retained.txt"));
            #[cfg(windows)]
            assert_eq!(replaced.unwrap_err().raw_os_error(), Some(32));
            #[cfg(unix)]
            {
                replaced.unwrap();
                if link {
                    std::os::unix::fs::symlink(&outside, &target).unwrap();
                } else {
                    fs::copy(&outside, &target).unwrap();
                }
            }
        });
        let _ = link;
        assert!(
            attempted,
            "the actual native replacement window must execute"
        );
        #[cfg(windows)]
        assert!(result.unwrap().is_empty());
        #[cfg(unix)]
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(outside).unwrap(),
            r"\Users\outside-must-never-be-read"
        );
        let retained = if cfg!(windows) {
            target
        } else {
            fixture.path("retained.txt")
        };
        assert_eq!(fs::read_to_string(retained).unwrap(), "inside bytes");
    }

    #[test]
    fn held_file_cannot_be_replaced_by_regular_outside_bytes() {
        file_replacement(false);
    }

    #[test]
    fn held_file_cannot_be_replaced_by_an_outside_link() {
        file_replacement(true);
    }

    fn directory_replacement(level: &str) {
        let fixture = Fixture::new();
        let parent = fixture.path("parent");
        let packet = parent.join("packet");
        fs::create_dir_all(packet.join("nested")).unwrap();
        fs::write(packet.join("nested/inside.txt"), "inside bytes").unwrap();
        let outside = fixture.path("outside");
        fs::create_dir_all(outside.join("packet/nested")).unwrap();
        fs::write(
            outside.join("outside.txt"),
            r"\Users\outside-must-never-be-read",
        )
        .unwrap();
        fs::write(
            outside.join("packet/nested/outside.txt"),
            r"\Users\outside-must-never-be-read",
        )
        .unwrap();
        let target = match level {
            "ancestor" => parent,
            "root" => packet.clone(),
            _ => packet.join("nested"),
        };
        let mut attempted = false;
        let mut read_names = Vec::new();
        let result = scan_with_hook(&packet, &mut |stage, relative, _| {
            if stage == Stage::FileHeld {
                read_names.push(relative.to_owned());
            }
            let window = if level == "root" {
                "packet"
            } else {
                "packet/nested"
            };
            if stage != Stage::DirectoryHeld || relative != Path::new(window) {
                return;
            }
            attempted = true;
            let replaced = fs::rename(&target, fixture.path("retained-directory"));
            #[cfg(windows)]
            assert_eq!(replaced.unwrap_err().raw_os_error(), Some(32));
            #[cfg(unix)]
            {
                replaced.unwrap();
                std::os::unix::fs::symlink(&outside, &target).unwrap();
            }
        });
        assert!(
            attempted,
            "replace between directory acquisition and enumeration"
        );
        assert_eq!(read_names, [PathBuf::from("packet/nested/inside.txt")]);
        #[cfg(windows)]
        assert!(result.unwrap().is_empty());
        #[cfg(unix)]
        assert!(result.is_err());
    }

    #[test]
    fn held_directory_fences_replacement_before_enumeration() {
        directory_replacement("nested");
    }

    #[test]
    fn held_ancestor_fences_replacement_before_enumeration() {
        directory_replacement("ancestor");
    }

    #[test]
    fn held_root_fences_replacement_before_enumeration() {
        directory_replacement("root");
    }

    #[test]
    fn held_file_detects_or_prevents_growth() {
        let fixture = Fixture::new();
        let target = fixture.path("growing.txt");
        fs::write(&target, "original").unwrap();
        let mut attempted = false;
        let result = scan_with_hook(&fixture.0, &mut |stage, _, _| {
            if stage != Stage::FileHeld {
                return;
            }
            attempted = true;
            let writer = fs::OpenOptions::new().append(true).open(&target);
            #[cfg(windows)]
            assert_eq!(writer.unwrap_err().raw_os_error(), Some(32));
            #[cfg(unix)]
            writer.unwrap().write_all(b" appended").unwrap();
        });
        assert!(attempted);
        #[cfg(windows)]
        assert!(result.unwrap().is_empty());
        #[cfg(unix)]
        assert!(result.unwrap_err().to_string().contains("changed"));
    }

    #[cfg(unix)]
    #[test]
    fn same_length_rewrite_with_restored_mtime_changes_ctime() {
        let fixture = Fixture::new();
        let target = fixture.path("rewritten.txt");
        fs::write(&target, "original").unwrap();
        let mtime = fs::metadata(&target).unwrap().modified().unwrap();
        let result = scan_with_hook(&fixture.0, &mut |stage, _, _| {
            if stage == Stage::FileHeld {
                std::thread::sleep(std::time::Duration::from_millis(10));
                let mut writer = fs::OpenOptions::new().write(true).open(&target).unwrap();
                writer.write_all(b"modified").unwrap();
                writer
                    .set_times(fs::FileTimes::new().set_modified(mtime))
                    .unwrap();
            }
        });
        assert!(result.unwrap_err().to_string().contains("changed"));
    }

    #[cfg(windows)]
    #[test]
    fn existing_writer_prevents_read_acquisition() {
        let fixture = Fixture::new();
        let target = fixture.path("writer.txt");
        fs::write(&target, "original").unwrap();
        let mut writer = fs::OpenOptions::new().write(true).open(&target).unwrap();
        assert!(scan_with_hook(&fixture.0, &mut |_, _, _| {}).is_err());
        writer.write_all(b"retained").unwrap();
    }

    #[test]
    fn discovery_includes_every_completion_packet_and_ignores_other_prs() {
        let fixture = Fixture::new();
        for name in [
            "pr226-integration-20260921",
            "pr226-local-validation",
            "pr-226-completion-20260922",
            "pr-226-completion-20260922-r4",
            "pr-226-completion-20990101-r99",
            "pr-227-completion-20990101",
        ] {
            fs::create_dir(fixture.path(name)).unwrap();
            fs::write(fixture.path(name).join("receipt.txt"), "<local-user>").unwrap();
        }
        fs::write(
            fixture.path("pr-226-completion-20990101-r99/receipt.txt"),
            r"\Users\new-leak",
        )
        .unwrap();
        let request = |inventory_only| Request {
            directories: vec![],
            discover: Some(fixture.0.clone()),
            inventory_only,
        };
        let inventory = scan(request(true)).unwrap();
        assert_eq!(inventory["directories"].as_array().unwrap().len(), 5);
        let result = scan(request(false)).unwrap();
        assert_eq!(result["directories"], inventory["directories"]);
        assert_eq!(
            result["files"],
            serde_json::json!(["pr-226-completion-20990101-r99/receipt.txt"])
        );
    }

    #[test]
    fn missing_packets_and_file_in_packet_namespace_fail_closed() {
        let fixture = Fixture::new();
        let request = || Request {
            directories: vec![],
            discover: Some(fixture.0.clone()),
            inventory_only: false,
        };
        assert!(scan(request()).is_err());
        fs::write(fixture.path("pr-226-completion-invalid"), "not a directory").unwrap();
        assert!(scan(request()).is_err());
    }

    #[cfg(windows)]
    fn nonjunction_reparse(during_scan: bool) {
        use std::os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        };
        use windows_sys::Win32::System::{
            IO::DeviceIoControl,
            Ioctl::{FSCTL_DELETE_REPARSE_POINT, FSCTL_SET_REPARSE_POINT},
        };
        let fixture = Fixture::new();
        let target = fixture.path("nonjunction");
        fs::create_dir(&target).unwrap();
        let mut data = [0u8; 24];
        data[..4].copy_from_slice(&0x0000_0042u32.to_le_bytes());
        data[8..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        let handle = fs::OpenOptions::new()
            // These attribute-only rights can change reparse metadata despite a
            // FILE_SHARE_READ scanner handle. Keep this handle for owned cleanup:
            // reopening an unknown third-party GUID tag can require its filter.
            .access_mode(0x180)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(&target)
            .unwrap();
        assert!(
            scan_with_hook(&target, &mut |_, _, _| {})
                .unwrap()
                .is_empty(),
            "the attribute handle must not manufacture a sharing failure"
        );
        let control = |code| {
            let mut returned = 0;
            // SAFETY: the owned handle and initialized REPARSE_GUID_DATA_BUFFER
            // remain live for the synchronous call. Delete uses the same GUID/tag.
            let ok = unsafe {
                DeviceIoControl(
                    handle.as_raw_handle(),
                    code,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            assert_ne!(
                ok,
                0,
                "owned GUID reparse operation failed: {}",
                io::Error::last_os_error()
            );
        };
        if !during_scan {
            control(FSCTL_SET_REPARSE_POINT);
        }
        let mut reads = 0;
        let mut changed = false;
        let result = scan_with_hook(&target, &mut |stage, _, _| {
            if during_scan && stage == Stage::DirectoryHeld && !changed {
                control(FSCTL_SET_REPARSE_POINT);
                changed = true;
            }
            if stage == Stage::FileHeld {
                reads += 1;
            }
        });
        assert!(result.is_err());
        assert_eq!(
            changed, during_scan,
            "the held-directory mutation window must execute"
        );
        assert_eq!(reads, 0);
        // Metadata comes from the original handle, not an ambient path lookup.
        let metadata = handle.metadata().unwrap();
        assert_ne!(metadata.file_attributes() & 0x400, 0);
        assert!(
            !metadata.file_type().is_symlink(),
            "use a non-junction, non-symlink tag"
        );
        let metadata = File::from_std(handle.try_clone().unwrap())
            .metadata()
            .unwrap();
        assert!(!plain(&metadata));
        assert!(Root::open(&target).is_err());
        control(FSCTL_DELETE_REPARSE_POINT);
        drop(handle);
        fs::remove_dir(&target).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn native_nonjunction_reparse_directory_is_rejected() {
        nonjunction_reparse(false);
    }

    #[cfg(windows)]
    #[test]
    fn attribute_only_reparse_mutation_during_scan_is_rejected() {
        nonjunction_reparse(true);
    }
}
