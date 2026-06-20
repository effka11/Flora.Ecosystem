using Flora.Users.Contracts;
using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class UserProfileProvisioner(UsersDbContext db) : IUserProfileProvisioner
{
    public async Task EnsureInitialProfileAsync(Guid userUuid, string displayName, CancellationToken cancellationToken = default)
    {
        var exists = await db.UserProfiles.AnyAsync(p => p.UserUuid == userUuid, cancellationToken);
        if (exists) return;
        db.UserProfiles.Add(new UserProfile
        {
            UserUuid = userUuid,
            DisplayName = displayName
        });
        await db.SaveChangesAsync(cancellationToken);
    }
}
