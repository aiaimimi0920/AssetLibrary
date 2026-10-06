# Windows PowerShell's anonymous-pipe ReadToEndAsync uses blocking thread-pool
# work. Long-lived worker readers must not starve short Docker/tool probes.
if (-not ('AssetLibraryRunOutput' -as [type])) {
    Add-Type -TypeDefinition @'
using System.IO;
using System.Threading;
using System.Threading.Tasks;

public static class AssetLibraryRunOutput {
    public static Task<string> Read(StreamReader reader) {
        return Task.Factory.StartNew(() => reader.ReadToEnd(),
            CancellationToken.None, TaskCreationOptions.LongRunning,
            TaskScheduler.Default);
    }
}
'@
}
