//! Смоук арены: сквозной внешний транскод через ffmpeg (если он есть на
//! машине). Без ffmpeg тест пропускается — CI-гейты от него не зависят.

use frc_a_polygon::corpus;
use frc_a_polygon::external;
use frc_a_polygon::runner;

#[test]
fn external_transcode_smoke() {
    if external::info().is_none() {
        eprintln!("ffmpeg/ffprobe недоступны — смоук арены пропущен");
        return;
    }
    let available = external::available();
    let Some(&codec) = available.first() else {
        eprintln!("в сборке ffmpeg нет кодеков арены — смоук пропущен");
        return;
    };

    let item = corpus::by_name("multitone_48k").expect("кейс корпуса существует");
    let r = runner::run_case_external(&item, 96, codec).expect("внешний транскод должен пройти");

    assert_eq!(r.codec, codec.id());
    assert_eq!(r.bitrate_kbps, 96);
    // Битрейт в разумном коридоре вокруг цели (VBR-кодекам дан широкий люфт).
    assert!(
        r.actual_kbps > 8.0 && r.actual_kbps < 400.0,
        "битрейт вне коридора: {}",
        r.actual_kbps
    );
    // Метрики существуют и осмысленны: мультитон @96k любой кодек кодирует
    // заведомо лучше этих порогов; порог ловит рассинхрон выравнивания.
    assert!(
        r.quality.seg_snr_db > 5.0,
        "segSNR подозрительно низкий (сбой выравнивания?): {}",
        r.quality.seg_snr_db
    );
    assert!(
        r.quality.band_lsd_db < 10.0,
        "band-LSD подозрительно высокий: {}",
        r.quality.band_lsd_db
    );
    assert!(r.quality.nmr_db.is_finite());
}
