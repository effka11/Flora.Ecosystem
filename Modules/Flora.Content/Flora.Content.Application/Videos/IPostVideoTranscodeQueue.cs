namespace Flora.Content.Application.Videos;

/// <summary>Задание на транскодирование: временный файл оригинала принадлежит воркеру и удаляется им.</summary>
public sealed record PostVideoTranscodeJob(Guid VideoUuid, string TempInputPath);

public interface IPostVideoTranscodeQueue
{
    ValueTask EnqueueAsync(PostVideoTranscodeJob job, CancellationToken ct = default);
}
