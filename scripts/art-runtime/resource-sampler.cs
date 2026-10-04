using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

public sealed class ArtResourceSample {
    public string Label, Phase, TimestampUtc;
    public int ProcessId;
    public long WorkingSetBytes, PrivateBytes, LifetimePeakWorkingSetBytes;
    public double CpuTotalMilliseconds;
}

// Independent retained handles: the sampler never owns or terminates a service.
// These are Windows process counters, not Linux RSS or a phase-specific OS peak.
public sealed class ArtResourceSampler : IDisposable {
    private readonly List<Process> processes = new List<Process>();
    private readonly List<ArtResourceSample> samples = new List<ArtResourceSample>();
    private readonly string[] labels;
    private readonly object sync = new object();
    private readonly Thread thread;
    private volatile bool stopping;
    private string phase = "between-phases", failure;

    public ArtResourceSampler(string[] labels, int[] ids, string[] binaries) {
        if (labels.Length < 1 || labels.Length > 12 || ids.Length != labels.Length || binaries.Length != ids.Length)
            throw new ArgumentException("Invalid owned sampler identities");
        this.labels = (string[])labels.Clone();
        try {
            for (int i = 0; i < ids.Length; i++) {
                Process process = Process.GetProcessById(ids[i]);
                processes.Add(process);
                if (process.HasExited || !String.Equals(Path.GetFullPath(process.MainModule.FileName),
                    Path.GetFullPath(binaries[i]), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Owned sampler executable mismatch");
                IntPtr retained = process.Handle;
            }
            thread = new Thread(Collect);
            thread.IsBackground = true;
            thread.Start();
        } catch {
            foreach (Process process in processes) process.Dispose();
            throw;
        }
    }

    public void SetPhase(string value) {
        if (value != "idle" && value != "upload-and-scan" && value != "two-client-query" && value != "between-phases")
            throw new ArgumentException("Unknown resource phase");
        lock (sync) {
            phase = value;
            Capture();
        }
    }

    private void Collect() {
        try {
            while (!stopping) {
                lock (sync) Capture();
                Thread.Sleep(100);
            }
        } catch {
            lock (sync) failure = "Native resource collection failed";
        }
    }

    private void Capture() {
        if (samples.Count + processes.Count > 30000)
            throw new InvalidOperationException("Resource sample bound exceeded");
        for (int i = 0; i < processes.Count; i++) {
            Process process = processes[i];
            process.Refresh();
            if (process.HasExited) throw new InvalidOperationException("Owned sampled process exited");
            long workingSet = process.WorkingSet64, privateBytes = process.PrivateMemorySize64;
            long peak = process.PeakWorkingSet64;
            if (workingSet <= 0 || privateBytes <= 0 || peak <= 0)
                throw new InvalidOperationException("Missing native resource counters");
            samples.Add(new ArtResourceSample {
                Label = labels[i], Phase = phase, TimestampUtc = DateTime.UtcNow.ToString("o"),
                ProcessId = process.Id, WorkingSetBytes = workingSet, PrivateBytes = privateBytes,
                LifetimePeakWorkingSetBytes = peak, CpuTotalMilliseconds = process.TotalProcessorTime.TotalMilliseconds
            });
        }
    }

    public ArtResourceSample[] Snapshot() {
        lock (sync) {
            if (failure != null) throw new InvalidOperationException(failure);
            Capture();
            return samples.ToArray();
        }
    }

    public void Dispose() {
        stopping = true;
        try {
            if (!thread.Join(2000)) throw new InvalidOperationException("Resource sampler did not exit");
        } finally {
            foreach (Process process in processes) process.Dispose();
        }
    }
}
