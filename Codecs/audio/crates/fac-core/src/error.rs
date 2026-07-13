#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Недопустимая конфигурация кодека (частота/каналы/битрейт).
    InvalidConfig(&'static str),
    /// Неверные входные данные вызова (например, длина PCM-буфера).
    InvalidInput(&'static str),
    /// Синтаксически некорректный пакет или заголовок контейнера.
    InvalidPacket(&'static str),
    /// Поток закончился раньше, чем ожидал декодер.
    Truncated,
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Error::InvalidConfig(m) => write!(f, "invalid codec config: {m}"),
            Error::InvalidInput(m) => write!(f, "invalid input: {m}"),
            Error::InvalidPacket(m) => write!(f, "invalid packet: {m}"),
            Error::Truncated => write!(f, "truncated bitstream"),
        }
    }
}

impl std::error::Error for Error {}
