using Flora.Auth.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Flora.Auth.Infrastructure;

public class UserAccountConfiguration : IEntityTypeConfiguration<UserAccount>
{
    public void Configure(EntityTypeBuilder<UserAccount> builder)
    {
        builder.ToTable("user_accounts", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_accounts");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.Username).HasColumnName("username").IsRequired().HasMaxLength(50);
        builder.Property(e => e.Phone).HasColumnName("phone").IsRequired().HasMaxLength(20);
        builder.Property(e => e.PhoneVerified).HasColumnName("phone_verified").HasDefaultValue(false);
        builder.Property(e => e.PasswordHash).HasColumnName("password_hash").IsRequired();
        builder.Property(e => e.Email).HasColumnName("email").HasMaxLength(255);
        builder.Property(e => e.EmailVerified).HasColumnName("email_verified").HasDefaultValue(false);
        builder.Property(e => e.TwoFactorEnabled).HasColumnName("two_factor_enabled").HasDefaultValue(false);
        builder.Property(e => e.TwoFactorSecret).HasColumnName("two_factor_secret").HasMaxLength(128);
        builder.Property(e => e.Status).HasColumnName("status").HasConversion<int>().HasDefaultValue(UserAccountStatus.Active);
        builder.Property(e => e.LastLogin).HasColumnName("last_login");
        builder.Property(e => e.ServicesMask).HasColumnName("services_mask").HasDefaultValue(0UL);
        builder.Property(e => e.PrivacyAccepted).HasColumnName("privacy_accepted").HasDefaultValue(false);
        builder.Property(e => e.TosAccepted).HasColumnName("tos_accepted").HasDefaultValue(false);
        builder.Property(e => e.HasSocialNetwork).HasColumnName("has_social_network").HasDefaultValue(false);
        builder.Property(e => e.HasEmail).HasColumnName("has_email").HasDefaultValue(false);
        builder.Property(e => e.ServicesCount).HasColumnName("services_count").HasDefaultValue((byte)0);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
        builder.HasIndex(e => e.Username).IsUnique().HasDatabaseName("ix_user_accounts_username");
        builder.HasIndex(e => e.Phone).IsUnique().HasDatabaseName("ix_user_accounts_phone");
        builder.HasIndex(e => e.Email).IsUnique().HasDatabaseName("ix_user_accounts_email").HasFilter("email IS NOT NULL");

        builder.HasOne(e => e.SecurityLogs).WithOne().HasForeignKey<UserSecurityLogs>(s => s.UserUuid)
            .HasConstraintName("fk_user_accounts_user_security_logs").OnDelete(DeleteBehavior.Cascade);
        builder.HasMany(e => e.Sessions).WithOne().HasForeignKey(s => s.UserUuid)
            .HasConstraintName("fk_user_accounts_user_sessions").OnDelete(DeleteBehavior.Cascade);
    }
}

public class UserSecurityLogsConfiguration : IEntityTypeConfiguration<UserSecurityLogs>
{
    public void Configure(EntityTypeBuilder<UserSecurityLogs> builder)
    {
        builder.ToTable("user_security_logs", "flora_core");
        builder.HasKey(e => e.UserUuid).HasName("pk_user_security_logs");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.LastLogin).HasColumnName("last_login");
        builder.Property(e => e.PasswordUpdatedAt).HasColumnName("password_updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.LoginFailures).HasColumnName("login_failures").HasDefaultValue((byte)0);
        builder.Property(e => e.LoginLockedUntil).HasColumnName("login_locked_until");
        builder.Property(e => e.PrivacyAcceptedAt).HasColumnName("privacy_accepted_at");
        builder.Property(e => e.TosAcceptedAt).HasColumnName("tos_accepted_at");
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
    }
}

public class UserSessionConfiguration : IEntityTypeConfiguration<UserSession>
{
    public void Configure(EntityTypeBuilder<UserSession> builder)
    {
        builder.ToTable("user_sessions", "flora_core");
        builder.HasKey(e => e.SessionId).HasName("pk_user_sessions");
        builder.Property(e => e.SessionId).HasColumnName("session_id");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.AgentHash).HasColumnName("agent_hash").IsRequired().HasMaxLength(64);
        builder.Property(e => e.IpAddress).HasColumnName("ip_address").IsRequired().HasMaxLength(45);
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(e => e.LastActivity).HasColumnName("last_activity").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.JwtId).HasColumnName("jwt_id").IsRequired().HasMaxLength(36);
        builder.Property(e => e.RefreshToken).HasColumnName("refresh_token").IsRequired().HasMaxLength(512);
        builder.Property(e => e.RotationId).HasColumnName("rotation_id").HasDefaultValue(0u);
        builder.Property(e => e.Status).HasColumnName("status").HasConversion<int>().HasDefaultValue(UserSessionStatus.Active);
        builder.Property(e => e.CountryCode).HasColumnName("country_code").HasMaxLength(2);
        builder.Property(e => e.Region).HasColumnName("region").HasMaxLength(100);
        builder.Property(e => e.City).HasColumnName("city").HasMaxLength(100);
        builder.Property(e => e.CsrfToken).HasColumnName("csrf_token").IsRequired().HasMaxLength(64);
        builder.Property(e => e.HmacKey).HasColumnName("hmac_key").IsRequired().HasMaxLength(128);
        builder.HasIndex(e => e.UserUuid).HasDatabaseName("ix_user_sessions_user_uuid");
        builder.HasIndex(e => e.RefreshToken).IsUnique().HasDatabaseName("ix_user_sessions_refresh_token");
        builder.HasIndex(e => e.JwtId).IsUnique().HasDatabaseName("ix_user_sessions_jwt_id");
        builder.HasIndex(e => new { e.UserUuid, e.Status, e.ExpiresAt }).HasDatabaseName("ix_user_sessions_active").HasFilter("status = 0");
    }
}

public class PendingEmailChangeConfiguration : IEntityTypeConfiguration<PendingEmailChange>
{
    public void Configure(EntityTypeBuilder<PendingEmailChange> builder)
    {
        builder.ToTable("pending_email_changes", "flora_core");
        builder.HasKey(e => e.ChangeToken).HasName("pk_pending_email_changes");
        builder.Property(e => e.ChangeToken).HasColumnName("change_token");
        builder.Property(e => e.UserUuid).HasColumnName("user_uuid");
        builder.Property(e => e.NewEmail).HasColumnName("new_email").IsRequired().HasMaxLength(255);
        builder.Property(e => e.VerificationCodeHash).HasColumnName("verification_code_hash").IsRequired().HasMaxLength(128);
        builder.Property(e => e.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
        builder.HasIndex(e => e.UserUuid).HasDatabaseName("ix_pending_email_changes_user_uuid");
        builder.HasIndex(e => e.NewEmail).HasDatabaseName("ix_pending_email_changes_new_email");
        builder.HasIndex(e => e.ExpiresAt).HasDatabaseName("ix_pending_email_changes_expires_at");
    }
}

public class PendingRegistrationConfiguration : IEntityTypeConfiguration<PendingRegistration>
{
    public void Configure(EntityTypeBuilder<PendingRegistration> builder)
    {
        builder.ToTable("pending_registrations", "flora_core");
        builder.HasKey(e => e.VerificationToken).HasName("pk_pending_registrations");
        builder.Property(e => e.VerificationToken).HasColumnName("verification_token");
        builder.Property(e => e.Email).HasColumnName("email").IsRequired().HasMaxLength(255);
        builder.Property(e => e.Username).HasColumnName("username").IsRequired().HasMaxLength(50);
        builder.Property(e => e.PasswordHash).HasColumnName("password_hash").IsRequired();
        builder.Property(e => e.VerificationCodeHash).HasColumnName("verification_code_hash").IsRequired().HasMaxLength(128);
        builder.Property(e => e.ExpiresAt).HasColumnName("expires_at").IsRequired();
        builder.Property(e => e.CreatedAt).HasColumnName("created_at").HasDefaultValueSql("CURRENT_TIMESTAMP");
        builder.Property(e => e.UpdatedAt).HasColumnName("updated_at").HasDefaultValueSql("CURRENT_TIMESTAMP").ValueGeneratedOnAddOrUpdate();
        builder.HasIndex(e => e.Email).HasDatabaseName("ix_pending_registrations_email");
        builder.HasIndex(e => e.ExpiresAt).HasDatabaseName("ix_pending_registrations_expires_at");
    }
}
