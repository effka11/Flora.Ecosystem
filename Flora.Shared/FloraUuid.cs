namespace Flora.Shared;

/// <summary>UUID v7 (RFC 9562, time-ordered). Для детерминированных id — <see cref="UuidV5"/>.</summary>
public static class FloraUuid
{
    public static Guid NewGuid() => Guid.CreateVersion7();
}
