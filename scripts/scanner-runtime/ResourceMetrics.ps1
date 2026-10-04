# Windows keeps process times and peak working set on an open process handle.
# Query the retained handle after exit, not a sampled or inferred RSS value.
if (-not ('ScannerResourceMetrics' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ScannerResourceMetrics {
    [StructLayout(LayoutKind.Sequential)]
    private struct Counters {
        public uint Size, PageFaults;
        public UIntPtr PeakWorkingSet, WorkingSet, PeakPagedPool, PagedPool;
        public UIntPtr PeakNonPagedPool, NonPagedPool, Pagefile, PeakPagefile;
    }
    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(IntPtr process, out Counters counters, uint size);
    public static ulong PeakWorkingSet(IntPtr process) {
        Counters counters;
        if (!GetProcessMemoryInfo(process, out counters, (uint)Marshal.SizeOf(typeof(Counters))))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (counters.PeakWorkingSet.ToUInt64() == 0)
            throw new InvalidOperationException("Missing process peak working set");
        return counters.PeakWorkingSet.ToUInt64();
    }
}
'@
}

function Invoke-MeasuredInspector([string] $Binary, [string] $Directory) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary; $start.Arguments = '--inspect-local'; $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Clear(); $start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $started = $false
    try {
        [void]$process.Start()
        $started = $true
        $handle = $process.Handle
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            throw 'Inspector measurement exceeded 30 seconds'
        }
        $watch.Stop()
        if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Inspector output did not close' }
        if ($process.ExitCode -ne 0 -or $stdout.Result -or $stderr.Result) { throw 'Inspector protocol process failed' }
        [pscustomobject]@{
            peak_working_set_bytes = [ScannerResourceMetrics]::PeakWorkingSet($handle)
            cpu_ms = $process.TotalProcessorTime.TotalMilliseconds
            elapsed_ms = $watch.Elapsed.TotalMilliseconds
            peak_query_after_exit = $true
        }
    } finally {
        try {
            if ($started -and -not $process.HasExited) {
                try { $process.Kill() }
                catch { if (-not $process.HasExited) { throw } }
                if (-not $process.WaitForExit(5000)) { throw 'Inspector cleanup did not exit' }
            }
        } finally {
            # Even a status-query or termination failure must release the handle.
            $process.Dispose()
        }
    }
}
