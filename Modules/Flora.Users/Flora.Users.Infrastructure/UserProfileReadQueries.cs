using Flora.Users.Contracts;
using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class UserProfileReadQueries(UsersDbContext db) : IUserProfileReadQueries
{
    public async Task<UserProfileRow?> FindByUserUuidAsync(Guid userUuid, CancellationToken cancellationToken = default)
    {
        var p = await db.UserProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.UserUuid == userUuid, cancellationToken);
        return p == null ? null : Map(p);
    }

    public async Task<IReadOnlyList<UserProfileRow>> GetByUserUuidsAsync(IReadOnlyCollection<Guid> userUuids, CancellationToken cancellationToken = default)
    {
        if (userUuids.Count == 0) return Array.Empty<UserProfileRow>();
        var list = await db.UserProfiles.AsNoTracking()
            .Where(p => userUuids.Contains(p.UserUuid))
            .ToListAsync(cancellationToken);
        return list.Select(Map).ToList();
    }

    private static UserProfileRow Map(UserProfile p) => new(
        p.UserUuid,
        p.DisplayName,
        p.AvatarUuid,
        p.Gender.HasValue ? (int)p.Gender.Value : null,
        p.BirthDate,
        p.Status);
}
