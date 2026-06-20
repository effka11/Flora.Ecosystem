namespace Flora.Music.Application.Playlists;

public static class SystemPlaylistIds
{
    public const string UploadedPersonal = "uploaded-personal";
    public const string UploadedPlatform = "uploaded-platform";

    public static bool IsSystem(string playlistId) =>
        playlistId == UploadedPersonal || playlistId == UploadedPlatform;
}
