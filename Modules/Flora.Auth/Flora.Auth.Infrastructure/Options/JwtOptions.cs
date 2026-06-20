namespace Flora.Auth.Infrastructure.Options;

public class JwtOptions
{
    public const string SectionName = "Jwt";

    public string Issuer { get; set; } = "Flora.Auth";
    public string Audience { get; set; } = "Flora.Ecosystem";
    public string Secret { get; set; } = "";
    public int AccessTokenMinutes { get; set; } = 15;
    public int RefreshTokenDays { get; set; } = 7;
}
