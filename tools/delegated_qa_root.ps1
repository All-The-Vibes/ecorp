#requires -Version 7.4
# Resolve physical directory identity before creating fixture files or reading
# ownership. Resolve-Path alone retains junction, short-name and subst aliases.
function Resolve-DelegatedQaRoot {
    param(
        [Parameter(Mandatory)][string]$QaRoot,
        [Parameter(Mandatory)][string]$ProductRoot,
        [switch]$RequireExists
    )
    if (!$IsWindows -or $QaRoot -notmatch '^[a-zA-Z]:[\\/]' -or
        ![IO.Path]::IsPathFullyQualified($QaRoot)) {
        throw 'Delegated acceptance requires an absolute local Windows QA directory.'
    }
    if (!('ECorp.DelegatedDirectoryPath' -as [type])) {
        # Thin binding to the native canonical-path API: no shell/path alias
        # expansion and no authority inferred from a lexical path prefix.
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace ECorp {
    public static class DelegatedDirectoryPath {
        [StructLayout(LayoutKind.Sequential)]
        private struct Information {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path,
            uint length, uint flags);
        public static string Canonical(string path) {
            using (var handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                Information info;
                if (!GetFileInformationByHandle(handle, out info))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if ((info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0)
                    throw new InvalidOperationException("QA ancestors must be real directories.");
                var value = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(handle, value, (uint)value.Capacity, 0);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (length >= value.Capacity) throw new InvalidOperationException("Unbounded directory path.");
                string result = value.ToString();
                if (!result.StartsWith(@"\\?\") || result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("QA directories must resolve to a local drive.");
                return result.Substring(4);
            }
        }
    }
}
'@
    }
    function Assert-DirectoryAncestors([string]$Path) {
        $cursor=$Path
        while ($cursor) {
            $attributes=[IO.File]::GetAttributes($cursor)
            if (!($attributes -band [IO.FileAttributes]::Directory) -or
                ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'QA roots and every existing ancestor must be ordinary directories.'
            }
            $cursor=[IO.Path]::GetDirectoryName($cursor)
        }
    }
    function Physical-Directory([string]$Path,[bool]$MustExist) {
        $full=[IO.Path]::GetFullPath($Path)
        if ($full.Length -gt [IO.Path]::GetPathRoot($full).Length) { $full=$full.TrimEnd('\') }
        $cursor=$full
        $suffix=[Collections.Generic.List[string]]::new()
        while ($true) {
            try { [void][IO.File]::GetAttributes($cursor); break }
            catch [IO.FileNotFoundException] { }
            catch [IO.DirectoryNotFoundException] { }
            if ($MustExist) { throw 'The owned QA directory must already exist.' }
            $suffix.Insert(0,[IO.Path]::GetFileName($cursor))
            $cursor=[IO.Path]::GetDirectoryName($cursor)
            if (!$cursor) { throw 'No existing local directory anchors this QA path.' }
        }
        Assert-DirectoryAncestors $cursor
        $physical=[ECorp.DelegatedDirectoryPath]::Canonical($cursor)
        # A substituted drive can hide ancestors above its apparent drive root.
        Assert-DirectoryAncestors $physical
        foreach ($component in $suffix) { $physical=[IO.Path]::Combine($physical,$component) }
        return $physical.TrimEnd('\')
    }
    $qa=Physical-Directory $QaRoot $RequireExists.IsPresent
    $product=Physical-Directory $ProductRoot $true
    $comparison=[StringComparison]::OrdinalIgnoreCase
    if ((Split-Path -Leaf $qa) -notmatch '^delegated-keycloak-[a-zA-Z0-9-]+$' -or
        $qa.Equals($product,$comparison) -or $qa.StartsWith($product+'\',$comparison) -or
        $product.StartsWith($qa+'\',$comparison)) {
        throw 'Use an independent delegated-keycloak-* QA directory outside the product.'
    }
    return $qa
}
