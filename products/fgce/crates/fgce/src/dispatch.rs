//! One `match` over `Request`; no formulas here (`fgce.md` §13).

use crate::contract::{Blend, Error, Grid, Info, PixelFormat, Request, Response, Stroke};
use crate::{
    Engine, MAX_CLIP, MAX_COORD, MAX_K, MAX_SIDE, MAX_VERTICES, State, VERSION, frame, lattice,
    place, spx, store, tree, vector,
};

pub(crate) fn submit<'e, 'r>(
    engine: &'e mut Engine,
    request: Request<'r>,
) -> Result<Response<'e>, Error> {
    match request {
        Request::Info => Ok(Response::Info(info())),
        Request::Grid { k } => {
            let fine = spx::fine(k)?;
            Ok(Response::Grid(Grid {
                fine,
                primary: spx::primary(k)?,
            }))
        }
        Request::Length { n, k } => Ok(Response::Length(spx::length(n, k)?)),
        Request::Lattice {
            span_x,
            span_y,
            step,
            pin_x,
            pin_y,
        } => {
            let calc = lattice::compute(span_x, span_y, step, pin_x, pin_y)?;
            Ok(Response::Lattice(calc.lattice))
        }
        Request::EdgePx { edge, k } => {
            let value = match edge {
                crate::contract::Edge::Grid { .. } => spx::parse_edge(edge, true, k)?,
                crate::contract::Edge::Pixel(_) => spx::parse_edge(edge, false, k)?,
            };
            Ok(Response::EdgePx(value))
        }
        Request::Measure {
            verbs,
            fill,
            stroke,
        } => match (fill, stroke) {
            (Some(fill), None) => Ok(Response::Measure(vector::measure_with(
                verbs,
                fill.rule,
                &mut engine.scratch,
            )?)),
            (None, Some(stroke)) => Ok(Response::Measure(vector::measure_stroke_with(
                verbs,
                &stroke,
                &mut engine.scratch,
            )?)),
            _ => Err(Error::BadPath),
        },
        Request::Begin { width, height } => {
            let live_before = engine.references.live_size();
            let active_before = engine.references.active_key();
            frame::begin(
                &mut engine.frame,
                &mut engine.state,
                &mut engine.clip,
                &mut engine.builtin_canon,
                width,
                height,
            )?;
            engine.scratch.fit(width as usize);
            engine.references.begin(engine.builtin_canon, width, height);
            if engine.references.clear_shows() {
                engine.live_dirty = true;
            }
            if engine.references.live_size() != live_before
                || engine.references.active_key() != active_before
            {
                engine.live_dirty = true;
            }
            Ok(Response::None)
        }
        Request::End => {
            if engine.state != State::Begun {
                return Err(Error::NotBegun);
            }
            ensure_live(engine)?;
            let key = engine.references.active_key();
            let k = engine.references.context().ok_or(Error::NotBegun)?.k;
            frame::draw_tree(
                &mut engine.frame,
                &engine.store,
                engine.references.tree(key),
                &mut engine.scratch,
                &mut engine.corners,
                k,
            )?;
            Ok(Response::Frame(frame::end(
                &mut engine.frame,
                &mut engine.state,
            )?))
        }
        Request::ReadPixels { rect, alpha } => Ok(Response::Pixels(frame::read_pixels(
            &engine.frame,
            engine.state,
            &engine.clip,
            rect,
            alpha,
        )?)),
        Request::Upload {
            id,
            width,
            height,
            stride,
            format,
            alpha,
            bytes,
        } => {
            let op = store::UploadOp {
                id,
                width,
                height,
                stride,
                format,
                alpha,
                bytes,
            };
            let image = store::prepare(&op)?;
            engine
                .references
                .validate_upload(op.id, image.width, image.height, image.format)?;
            let (image_width, image_height) = (image.width, image.height);
            store::insert(&mut engine.store, op.id, image);
            let keys = engine
                .references
                .apply_upload(op.id, image_width, image_height);
            if keys.contains(&engine.references.active_key()) {
                engine.live_dirty = true;
            }
            for key in keys {
                let Some(context) = engine.references.context_for(key) else {
                    continue;
                };
                let mut next = engine.references.tree(key).clone();
                place::canonical_pass(&mut next, &context);
                engine.references.replace_tree(key, next);
            }
            Ok(Response::None)
        }
        Request::Drop { id } => {
            if !engine.references.drop_allowed(id) {
                return Err(Error::UnknownImage);
            }
            engine.store.drop_image(id)?;
            Ok(Response::None)
        }
        Request::FillRect { rect, color, blend } => {
            frame::fill_rect(
                engine.state,
                &mut engine.frame,
                &engine.clip,
                rect,
                color,
                blend.unwrap_or(Blend::SrcOver),
            )?;
            Ok(Response::None)
        }
        Request::Blit {
            id,
            dest,
            src,
            sample,
            tint,
            blend,
            radius,
        } => {
            let request = frame::BlitRequest {
                id,
                dest,
                src,
                sample,
                tint,
                blend: blend.unwrap_or(Blend::SrcOver),
                radius,
            };
            let k = engine.references.context().ok_or(Error::NotBegun)?.k;
            frame::blit(
                engine.state,
                &mut engine.frame,
                &engine.store,
                &engine.clip,
                &request,
                &mut engine.corners,
                k,
            )?;
            Ok(Response::None)
        }
        Request::FillPath {
            verbs,
            rule,
            color,
            blend,
        } => {
            frame::fill_path(
                engine.state,
                &mut engine.frame,
                &engine.clip,
                verbs,
                rule,
                color,
                blend.unwrap_or(Blend::SrcOver),
                &mut engine.scratch,
            )?;
            Ok(Response::None)
        }
        Request::StrokePath {
            verbs,
            width,
            align,
            join,
            cap,
            color,
            blend,
        } => {
            let stroke = Stroke {
                width,
                align,
                join,
                cap,
            };
            frame::stroke_path(
                engine.state,
                &mut engine.frame,
                &engine.clip,
                verbs,
                &stroke,
                color,
                blend.unwrap_or(Blend::SrcOver),
                &mut engine.scratch,
            )?;
            Ok(Response::None)
        }
        Request::ClipPush { rect } => {
            frame::clip_push(
                engine.state,
                &mut engine.clip,
                frame::frame_rect(&engine.frame),
                rect,
            )?;
            Ok(Response::None)
        }
        Request::ClipPop => {
            frame::clip_pop(engine.state, &mut engine.clip)?;
            Ok(Response::None)
        }
        Request::DefineReference {
            id,
            canon_w,
            canon_h,
            k,
            d,
            pin,
            enter_cols,
            enter_rows,
        } => {
            engine.references.define(&tree::DefineOp {
                id,
                canon_w,
                canon_h,
                k,
                d,
                pin,
                enter_cols,
                enter_rows,
            })?;
            engine.live_dirty = true;
            Ok(Response::None)
        }
        Request::UseReference { id } => {
            let active_before = engine.references.active_key();
            engine.references.use_reference(id.0, engine.state)?;
            if engine.references.active_key() != active_before {
                engine.references.clear_shows();
            }
            engine.live_dirty = true;
            Ok(Response::None)
        }
        Request::Entity(entity) => {
            engine.references.require_canon()?;
            let key = engine.references.active_key();
            let context = engine.references.context().ok_or(Error::NotBegun)?;
            let mut next = engine.references.tree(key).clone();
            tree::apply_entity(
                &mut next,
                &entity,
                &engine.store,
                &context,
                key,
                &engine.references,
                &mut engine.scratch,
            )?;
            place::canonical_pass(&mut next, &context);
            tree::validate_tree(&next)?;
            commit(engine, key, next);
            Ok(Response::None)
        }
        Request::Group {
            id,
            parent,
            children,
            pin,
            snap,
            inset,
        } => {
            engine.references.require_canon()?;
            let key = engine.references.active_key();
            let context = engine.references.context().ok_or(Error::NotBegun)?;
            let mut next = engine.references.tree(key).clone();
            tree::apply_group(
                &mut next,
                &tree::GroupOp {
                    id,
                    parent,
                    children,
                    pin,
                    snap,
                    inset,
                },
                &context,
                key,
                &engine.references,
            )?;
            place::canonical_pass(&mut next, &context);
            tree::validate_tree(&next)?;
            commit(engine, key, next);
            Ok(Response::None)
        }
        Request::Arbitrary {
            id,
            parent,
            on_grid,
            edges,
            children,
            pin,
            snap,
            inset,
        } => {
            engine.references.require_canon()?;
            let key = engine.references.active_key();
            let context = engine.references.context().ok_or(Error::NotBegun)?;
            let mut next = engine.references.tree(key).clone();
            tree::apply_arbitrary(
                &mut next,
                &tree::ArbitraryOp {
                    id,
                    parent,
                    on_grid,
                    edges,
                    children,
                    pin,
                    snap,
                    inset,
                },
                &context,
                key,
                &engine.references,
            )?;
            place::canonical_pass(&mut next, &context);
            tree::validate_tree(&next)?;
            commit(engine, key, next);
            Ok(Response::None)
        }
        Request::Remove { id } => {
            let key = engine.references.active_key();
            let mut next = engine.references.tree(key).clone();
            tree::apply_remove(&mut next, id)?;
            let context = engine.references.context().ok_or(Error::NotBegun)?;
            place::canonical_pass(&mut next, &context);
            tree::validate_tree(&next)?;
            commit(engine, key, next);
            Ok(Response::None)
        }
        Request::Show { id, rect } => {
            if engine.state != State::Begun {
                return Err(Error::NotBegun);
            }
            if id.0 == 0 {
                return Err(Error::BadParent);
            }
            if rect.is_empty() {
                return Err(Error::BadCell);
            }
            place::rect_sides(rect)?;
            let key = engine.references.active_key();
            if !engine.references.tree(key).nodes.contains_key(&id) {
                return Err(Error::UnknownNode);
            }
            engine.references.show(id, rect);
            engine.live_dirty = true;
            Ok(Response::None)
        }
        Request::Place { id, rect } => {
            if engine.state == State::Empty {
                return Err(Error::NotBegun);
            }
            ensure_live(engine)?;
            let params = engine.references.live_params().ok_or(Error::NotBegun)?;
            let key = engine.references.active_key();
            let context = engine.references.context().ok_or(Error::NotBegun)?;
            let mut next = engine.references.tree(key).clone();
            place::place_node(&mut next, id, rect, &params)?;
            place::canonical_pass(&mut next, &context);
            tree::validate_tree(&next)?;
            engine.references.clear_show(id);
            commit(engine, key, next);
            Ok(Response::None)
        }
        Request::Snapshot => {
            if engine.state == State::Empty {
                return Err(Error::NotBegun);
            }
            ensure_live(engine)?;
            let key = engine.references.active_key();
            Ok(Response::Snapshot(place::snapshot(
                engine.references.tree(key),
                engine.references.generation(),
            )))
        }
    }
}

fn commit(engine: &mut Engine, key: tree::RefKey, next: tree::Tree) {
    engine.references.replace_tree(key, next);
    engine.references.rebuild_refs(key);
    engine.live_dirty = true;
}

/// Recomputes live rectangles when an input changed since the last pass
/// (`fgce.md` §4.6). `generation` grows only when the pass wrote new boxes.
fn ensure_live(engine: &mut Engine) -> Result<(), Error> {
    if !engine.live_dirty {
        return Ok(());
    }
    let params = engine.references.live_params().ok_or(Error::NotBegun)?;
    let key = engine.references.active_key();
    let mut next = engine.references.tree(key).clone();
    let changed = place::live_pass(&mut next, &params, engine.references.shows())?;
    engine.references.replace_tree(key, next);
    if changed {
        engine.references.bump_generation();
    }
    engine.live_dirty = false;
    Ok(())
}

fn info() -> Info {
    Info {
        version: VERSION,
        max_side: MAX_SIDE,
        max_k: MAX_K,
        max_clip: MAX_CLIP,
        max_vertices: MAX_VERTICES,
        max_coord: MAX_COORD as u32,
        pixel_format: PixelFormat::Rgba8,
        premultiplied: true,
    }
}
