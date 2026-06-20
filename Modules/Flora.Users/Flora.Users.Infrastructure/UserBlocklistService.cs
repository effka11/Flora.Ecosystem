using Flora.Users.Contracts;
using Flora.Users.Domain;
using Microsoft.EntityFrameworkCore;

namespace Flora.Users.Infrastructure;

public sealed class UserBlocklistService(UsersDbContext db) : IUserBlocklistService
{
    public Task<bool> IsBlockedByAsync(Guid ownerUserUuid, Guid viewerUserUuid, CancellationToken cancellationToken = default) =>
        db.UserBlocks.AsNoTracking()
            .AnyAsync(
                b => b.OwnerUserUuid == ownerUserUuid && b.BlockedUserUuid == viewerUserUuid,
                cancellationToken);

    public async Task<IReadOnlyList<UserBlockRecord>> ListAsync(Guid ownerUserUuid, CancellationToken cancellationToken = default)
    {
        var rows = await db.UserBlocks.AsNoTracking()
            .Where(b => b.OwnerUserUuid == ownerUserUuid)
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new UserBlockRecord(b.BlockedUserUuid, b.CreatedAt))
            .ToListAsync(cancellationToken);
        return rows;
    }

    public async Task BlockAsync(Guid ownerUserUuid, Guid blockedUserUuid, CancellationToken cancellationToken = default)
    {
        if (ownerUserUuid == blockedUserUuid)
            throw new InvalidOperationException("Нельзя заблокировать себя.");

        var exists = await db.UserBlocks.AsNoTracking()
            .AnyAsync(
                b => b.OwnerUserUuid == ownerUserUuid && b.BlockedUserUuid == blockedUserUuid,
                cancellationToken);
        if (exists) return;

        db.UserBlocks.Add(new UserBlock
        {
            OwnerUserUuid = ownerUserUuid,
            BlockedUserUuid = blockedUserUuid,
        });
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task UnblockAsync(Guid ownerUserUuid, Guid blockedUserUuid, CancellationToken cancellationToken = default)
    {
        var row = await db.UserBlocks
            .FirstOrDefaultAsync(
                b => b.OwnerUserUuid == ownerUserUuid && b.BlockedUserUuid == blockedUserUuid,
                cancellationToken);
        if (row is null) return;
        db.UserBlocks.Remove(row);
        await db.SaveChangesAsync(cancellationToken);
    }
}
