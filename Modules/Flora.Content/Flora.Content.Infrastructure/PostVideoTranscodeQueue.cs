using System.Threading.Channels;
using Flora.Content.Application.Videos;

namespace Flora.Content.Infrastructure;

/// <summary>In-memory очередь транскодирования (singleton). При рестарте процесса задания теряются —
/// зависшие строки Processing добиваются воркером в Failed.</summary>
public sealed class PostVideoTranscodeQueue : IPostVideoTranscodeQueue
{
    private readonly Channel<PostVideoTranscodeJob> _channel =
        Channel.CreateUnbounded<PostVideoTranscodeJob>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

    public ChannelReader<PostVideoTranscodeJob> Reader => _channel.Reader;

    public ValueTask EnqueueAsync(PostVideoTranscodeJob job, CancellationToken ct = default) =>
        _channel.Writer.WriteAsync(job, ct);
}
