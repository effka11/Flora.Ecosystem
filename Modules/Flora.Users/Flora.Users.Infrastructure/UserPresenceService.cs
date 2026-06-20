using Flora.Users.Contracts;
using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class UserPresenceService(UsersDbContext db) : IUserPresenceService
{
    public async Task TouchAsync(Guid userUuid, CancellationToken cancellationToken = default)
    {
        var row = await db.UserPresences.FindAsync([userUuid], cancellationToken);
        var now = DateTime.UtcNow;
        if (row is null)
        {
            db.UserPresences.Add(new UserPresence { UserUuid = userUuid, LastSeenAtUtc = now });
        }
        else
        {
            row.LastSeenAtUtc = now;
        }

        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task<IReadOnlyDictionary<Guid, DateTime?>> GetLastSeenUtcByUserUuidsAsync(
        IReadOnlyCollection<Guid> userUuids,
        CancellationToken cancellationToken = default)
    {
        if (userUuids.Count == 0) return new Dictionary<Guid, DateTime?>();

        var set = userUuids as HashSet<Guid> ?? userUuids.ToHashSet();
        var rows = await db.UserPresences.AsNoTracking()
            .Where(p => set.Contains(p.UserUuid))
            .Select(p => new { p.UserUuid, p.LastSeenAtUtc })
            .ToListAsync(cancellationToken);

        return rows.ToDictionary(x => x.UserUuid, x => (DateTime?)x.LastSeenAtUtc);
    }
}
