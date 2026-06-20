using NeoSolve.ImageSharp.AVIF;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;

namespace Flora.Social;

/// <summary>Конвертация загруженных фото поста в AVIF: ресайз, стриппинг метаданных, сжатие.</summary>
internal static class PostImageProcessor
{
    private const int MaxDimension = 2048;
    private const int AvifQuality = 75;
    // libavif default speed = 6 (NeoSolve AVIFEncoder не экспонирует Speed).

    /// <summary>
    /// Pixel budget guarding against decompression bombs — a tiny file that decodes into a huge
    /// bitmap and exhausts memory. ~50 MP comfortably covers legitimate phone/camera photos.
    /// </summary>
    private const long MaxPixels = 50_000_000;

    /// <summary>CQ 0–63 (ниже = лучше). Quality 75 → CQ ≈ 16 (перцептивно ≈ JPEG Q92).</summary>
    private static readonly AVIFEncoder Encoder = new()
    {
        CQLevel = (int)Math.Round((100 - AvifQuality) * 63.0 / 100.0),
    };

    /// <summary>
    /// Validates and re-encodes an uploaded image to AVIF. Decoding doubles as content validation
    /// (non-images throw), and re-encoding strips any embedded payload/metadata. Throws
    /// <see cref="InvalidOperationException"/> if the declared pixel dimensions exceed the budget.
    /// </summary>
    public static async Task<(byte[] Data, string ContentType)> ProcessAsync(Stream input, CancellationToken ct)
    {
        // Buffer once so we can read the header (bomb check) before committing to a full pixel decode.
        using var buffer = new MemoryStream();
        await input.CopyToAsync(buffer, ct);
        buffer.Position = 0;

        var info = await Image.IdentifyAsync(buffer, ct);
        if ((long)info.Width * info.Height > MaxPixels)
            throw new InvalidOperationException("Изображение слишком большое (превышен лимит пикселей).");
        buffer.Position = 0;

        using var image = await Image.LoadAsync(buffer, ct);

        if (image.Width > MaxDimension || image.Height > MaxDimension)
        {
            image.Mutate(x => x.Resize(new ResizeOptions
            {
                Mode = ResizeMode.Max,
                Size = new Size(MaxDimension, MaxDimension),
                Sampler = KnownResamplers.Lanczos3,
            }));
        }

        image.Metadata.ExifProfile = null;
        image.Metadata.IptcProfile = null;
        image.Metadata.XmpProfile = null;

        using var ms = new MemoryStream();
        await image.SaveAsync(ms, Encoder, ct);
        return (ms.ToArray(), "image/avif");
    }
}
