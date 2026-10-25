//! FGCE — 2D composition engine (`docs/fgce.md`).
//!
//! The crate is portable: no dependencies, no `unsafe`, one public entry point
//! `Engine::submit`. Internal modules are `pub(crate)`; they never become a
//! second public crate.

#![forbid(unsafe_code)]

mod blit;
mod color;
mod contract;
mod dispatch;
mod fill;
mod frame;
mod lattice;
mod place;
mod round;
mod span;
mod spx;
mod store;
mod tree;
mod vector;

pub use contract::*;

/// Crate version; the only format number of this release (`fgce.md` §1).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) const MAX_SIDE: u32 = 8192;
pub(crate) const MAX_K: u32 = 40;
pub(crate) const MAX_CLIP: u32 = 32;
pub(crate) const MAX_VERTICES: u32 = 65_536;
pub(crate) const MAX_COORD: i64 = 1_048_576;

pub(crate) fn align_up(value: usize, align: usize) -> usize {
    (value + align - 1) & !(align - 1)
}

/// Engine lifecycle (`fgce.md` §5.0).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum State {
    Empty,
    Begun,
    Ended,
}

pub struct Engine {
    pub(crate) state: State,
    pub(crate) frame: frame::FrameBuffer,
    pub(crate) clip: Vec<Rect>,
    pub(crate) store: store::Store,
    pub(crate) scratch: vector::RasterScratch,
    pub(crate) corners: round::CornerCache,
    pub(crate) builtin_canon: Option<(u32, u32)>,
    pub(crate) references: tree::References,
    pub(crate) live_dirty: bool,
}

impl Engine {
    /// Creates an empty engine without a frame buffer.
    pub fn new() -> Self {
        Engine {
            state: State::Empty,
            frame: frame::FrameBuffer::new(),
            clip: Vec::new(),
            store: store::Store::new(),
            scratch: vector::RasterScratch::default(),
            corners: round::CornerCache::default(),
            builtin_canon: None,
            references: tree::References::new(),
            live_dirty: false,
        }
    }

    /// The only working method of the crate (`fgce.md` §1, §5).
    pub fn submit<'a>(&mut self, request: Request<'a>) -> Result<Response<'_>, Error> {
        dispatch::submit(self, request)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_cargo_version() {
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn info_limits() {
        let mut engine = Engine::new();
        let Response::Info(info) = engine.submit(Request::Info).unwrap() else {
            panic!("expected info");
        };
        assert_eq!(info.version, VERSION);
        assert_eq!(info.max_side, 8192);
        assert_eq!(info.max_k, 40);
        assert_eq!(info.max_clip, 32);
        assert_eq!(info.max_vertices, 65_536);
        assert_eq!(info.max_coord, 1_048_576);
        assert_eq!(info.pixel_format, PixelFormat::Rgba8);
        assert!(info.premultiplied);
    }

    #[test]
    fn pure_queries_are_allowed_in_empty() {
        let mut engine = Engine::new();
        let Response::Grid(grid) = engine.submit(Request::Grid { k: 5 }).unwrap() else {
            panic!("expected grid");
        };
        assert_eq!(
            grid,
            Grid {
                fine: 5,
                primary: 15
            }
        );
        let Response::Length(length) = engine.submit(Request::Length { n: 22, k: 3 }).unwrap()
        else {
            panic!("expected length");
        };
        assert_eq!(length, 13);
        let Response::Lattice(lattice) = engine
            .submit(Request::Lattice {
                span_x: 91,
                span_y: 90,
                step: 15,
                pin_x: -1,
                pin_y: 1,
            })
            .unwrap()
        else {
            panic!("expected lattice");
        };
        assert_eq!(lattice.count_x, 7);
        assert_eq!(lattice.count_y, 6);
        assert_eq!(lattice.origin_x, 0);
        assert_eq!(lattice.origin_y, 0);
        let Response::EdgePx(edge) = engine
            .submit(Request::EdgePx {
                edge: Edge::Grid {
                    primary: 1,
                    fine: Some(1),
                    spx: Some(0),
                },
                k: 5,
            })
            .unwrap()
        else {
            panic!("expected edge");
        };
        assert_eq!(edge, 20);
    }

    #[test]
    fn impure_requests_are_not_begun_in_empty() {
        let mut engine = Engine::new();
        assert_eq!(engine.submit(Request::End).unwrap_err(), Error::NotBegun);
        assert_eq!(
            engine
                .submit(Request::ReadPixels {
                    rect: Rect {
                        x1: 0,
                        y1: 0,
                        x2: 0,
                        y2: 0
                    },
                    alpha: AlphaMode::Premul,
                })
                .unwrap_err(),
            Error::NotBegun
        );
        assert_eq!(
            engine
                .submit(Request::FillRect {
                    rect: Rect {
                        x1: 0,
                        y1: 0,
                        x2: 0,
                        y2: 0
                    },
                    color: Color {
                        r: 0,
                        g: 0,
                        b: 0,
                        a: 255
                    },
                    blend: None,
                })
                .unwrap_err(),
            Error::NotBegun
        );
        assert_eq!(
            engine
                .submit(Request::ClipPush {
                    rect: Rect {
                        x1: 0,
                        y1: 0,
                        x2: 0,
                        y2: 0
                    },
                })
                .unwrap_err(),
            Error::NotBegun
        );
        assert_eq!(
            engine.submit(Request::ClipPop).unwrap_err(),
            Error::NotBegun
        );
        assert_eq!(
            engine.submit(Request::Snapshot).unwrap_err(),
            Error::NotBegun
        );
    }

    #[test]
    fn begin_end_state_table() {
        let mut engine = Engine::new();
        assert!(matches!(
            engine
                .submit(Request::Begin {
                    width: 10,
                    height: 10
                })
                .unwrap(),
            Response::None
        ));
        let Response::Frame(frame) = engine.submit(Request::End).unwrap() else {
            panic!("expected frame");
        };
        assert_eq!(frame.width, 10);
        let _ = frame;
        assert_eq!(engine.submit(Request::End).unwrap_err(), Error::NotBegun);
        assert!(matches!(
            engine
                .submit(Request::ReadPixels {
                    rect: Rect {
                        x1: 0,
                        y1: 0,
                        x2: 0,
                        y2: 0
                    },
                    alpha: AlphaMode::Premul,
                })
                .unwrap(),
            Response::Pixels(_)
        ));
        engine
            .submit(Request::Begin {
                width: 10,
                height: 10,
            })
            .unwrap();
        assert!(matches!(
            engine.submit(Request::End).unwrap(),
            Response::Frame(_)
        ));
        assert_eq!(
            engine
                .submit(Request::FillRect {
                    rect: Rect {
                        x1: 0,
                        y1: 0,
                        x2: 0,
                        y2: 0
                    },
                    color: Color {
                        r: 1,
                        g: 1,
                        b: 1,
                        a: 1
                    },
                    blend: None,
                })
                .unwrap_err(),
            Error::NotBegun
        );
    }

    #[test]
    fn begin_limits() {
        let mut engine = Engine::new();
        assert_eq!(
            engine
                .submit(Request::Begin {
                    width: 0,
                    height: 10
                })
                .unwrap_err(),
            Error::SurfaceOutOfRange
        );
        assert_eq!(
            engine
                .submit(Request::Begin {
                    width: 8193,
                    height: 10
                })
                .unwrap_err(),
            Error::SurfaceOutOfRange
        );
        assert_eq!(
            engine
                .submit(Request::Begin {
                    width: 10,
                    height: 8193
                })
                .unwrap_err(),
            Error::SurfaceOutOfRange
        );
    }

    #[test]
    fn grid_rejects_bad_scale() {
        let mut engine = Engine::new();
        assert_eq!(
            engine.submit(Request::Grid { k: 0 }).unwrap_err(),
            Error::ScaleOutOfRange
        );
        assert_eq!(
            engine.submit(Request::Grid { k: 41 }).unwrap_err(),
            Error::ScaleOutOfRange
        );
    }

    #[test]
    fn one_end_draws_the_tree_once() {
        let mut engine = Engine::new();
        engine
            .submit(Request::Begin {
                width: 10,
                height: 10,
            })
            .unwrap();
        assert_eq!(engine.frame.tree_passes(), 0);
        engine.submit(Request::End).unwrap();
        assert_eq!(engine.frame.tree_passes(), 1);
        assert_eq!(engine.submit(Request::End).unwrap_err(), Error::NotBegun);
        assert_eq!(
            engine.frame.tree_passes(),
            1,
            "a rejected second End does not draw again"
        );
    }
}
