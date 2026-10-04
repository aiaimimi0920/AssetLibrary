using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

public sealed class ArtQuerySample {
    public int Client, Status;
    public long StartTicks, EndTicks;
    public string Body;
}

public sealed class ArtQueryResult {
    public ArtQuerySample[] Requests;
    public int PeakClientInFlight;
    public long StopwatchFrequency;
}

// Two gated clients with bounded public reads. In-flight windows are client-side
// evidence; they are not proof of overlapping SQL execution inside the server.
public static class ArtQueryLoad {
    private static int activeClients;
    public static int ActiveClientTasks { get { return Volatile.Read(ref activeClients); } }

    public static ArtQueryResult Run(string origin, int requestsPerClient) {
        return Run(origin, requestsPerClient, 15000);
    }

    public static ArtQueryResult Run(string origin, int requestsPerClient, int deadlineMilliseconds) {
        Uri uri = new Uri(origin);
        if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || !String.IsNullOrEmpty(uri.UserInfo)
            || !String.IsNullOrEmpty(uri.Query) || uri.AbsolutePath != "/" || !String.IsNullOrEmpty(uri.Fragment)
            || requestsPerClient < 1 || requestsPerClient > 25 || deadlineMilliseconds < 100 || deadlineMilliseconds > 15000)
            throw new ArgumentException("Expected bounded loopback query target");
        var results = new List<ArtQuerySample>();
        object sync = new object();
        int inFlight = 0, peak = 0;
        using (var ready = new CountdownEvent(2))
        using (var gate = new ManualResetEventSlim(false))
        using (var cancellation = new CancellationTokenSource())
        using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false })
        using (var client = new HttpClient(handler)) {
            client.Timeout = TimeSpan.FromSeconds(2);
            client.MaxResponseContentBufferSize = 65536;
            Task[] tasks = new Task[2];
            for (int index = 0; index < 2; index++) {
                int identity = index;
                tasks[index] = Task.Factory.StartNew(() => {
                    Interlocked.Increment(ref activeClients);
                    try {
                        ready.Signal();
                        if (!gate.Wait(3000, cancellation.Token)) throw new InvalidOperationException("Query start gate timed out");
                        for (int count = 0; count < requestsPerClient; count++) {
                            cancellation.Token.ThrowIfCancellationRequested();
                            var sample = new ArtQuerySample { Client = identity, StartTicks = Stopwatch.GetTimestamp() };
                            lock (sync) { inFlight++; peak = Math.Max(peak, inFlight); }
                            try {
                                using (HttpResponseMessage response = client.GetAsync(origin.TrimEnd('/') +
                                    "/v1/public/search?q=Isolated%20Art%20Flow&kind=art&tag=isolated&limit=2", cancellation.Token).GetAwaiter().GetResult()) {
                                    sample.Status = (int)response.StatusCode;
                                    if (sample.Status != 200) throw new InvalidOperationException("Public query dependency failed");
                                    sample.Body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                                }
                            } finally {
                                sample.EndTicks = Stopwatch.GetTimestamp();
                                lock (sync) { inFlight--; }
                            }
                            lock (sync) results.Add(sample);
                            cancellation.Token.WaitHandle.WaitOne(100);
                        }
                    } catch { cancellation.Cancel(); throw; }
                    finally { Interlocked.Decrement(ref activeClients); }
                }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            }
            // Always release the waiters before disposing their gate/client.
            try {
                bool started = ready.Wait(3000);
                gate.Set();
                if (!Task.WaitAll(tasks, deadlineMilliseconds)) throw new InvalidOperationException("Query load exceeded deadline");
                if (!started) throw new InvalidOperationException("Two query clients did not become ready");
            } catch {
                cancellation.Cancel();
                gate.Set();
                client.CancelPendingRequests();
                try { Task.WaitAll(tasks, 5000); } catch (AggregateException) { }
                foreach (Task task in tasks) {
                    if (!task.IsCompleted) throw new InvalidOperationException("Owned query tasks did not exit");
                }
                throw;
            }
        }
        return new ArtQueryResult { Requests = results.ToArray(), PeakClientInFlight = peak,
            StopwatchFrequency = Stopwatch.Frequency };
    }
}
