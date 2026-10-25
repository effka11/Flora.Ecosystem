# Набор conformance-тестов FGCE

Тестовый пакет `fgce-conformance` (план реализации, D2). Единственная
зависимость — `fgce` по path; публичного API пакет не поставляет. Каждая
проверка идёт через `Engine::submit`.

```sh
cargo test -p fgce-conformance
cargo test -p fgce-conformance --test <file>
cargo test -p fgce-conformance -- --ignored --nocapture   # regen fixtures
```

## Карта §12 → тест

Строка — номер строки таблицы §12 `docs/fgce.md` (нумерация с 1, без
заголовка). `conformance` — тест в этом пакете; `unit` — тест внутри
`crates/fgce` для внутренних величин, недостижимых через
`submit`; `typed` — строка описывает отсутствующее поле, которое в типовом
контракте Rust невозможно; `invariant` — свойство памяти/прохода.

| §12 | Статус | Тест |
|-----|--------|------|
| 1 | conformance | `meta_spx_lattice.rs::row_01_version_is_the_package_version` |
| 2 | conformance | `meta_spx_lattice.rs::row_02_info_limits` |
| 3 | conformance | `meta_spx_lattice.rs::row_03_scale_pair` |
| 4 | conformance | `meta_spx_lattice.rs::row_04_length` |
| 5 | conformance | `meta_spx_lattice.rs::row_05_lattice_window_91` |
| 6 | conformance | `meta_spx_lattice.rs::row_06_lattice_window_90` |
| 7 | conformance | `meta_spx_lattice.rs::row_07_live_window_91_by_90` |
| 8 | conformance | `meta_spx_lattice.rs::row_08_lattice_window_100_pin_zero` |
| 9 | conformance | `meta_spx_lattice.rs::row_09_lattice_window_100_near_pin` |
| 10 | conformance | `meta_spx_lattice.rs::row_10_lattice_window_100_far_pin` |
| 11–14 | conformance | `layout.rs::row_11_14_pin_axes` |
| 15 | conformance | `tree.rs::row_15_entity_wider_than_the_box_overflows` |
| 16 | conformance | `store_blit.rs::row_16_repeat_upload_beyond_the_box` |
| 17 | conformance | `layout.rs::row_17_align_right_and_center` |
| 18 | conformance | `layout.rs::row_18_align_left_bottom` |
| 19 | conformance | `layout.rs::row_19_vector_and_flat_reject_align` |
| 20 | conformance | `tree.rs::row_20_bad_nudges` |
| 21 | conformance | `tree.rs::row_21_spx_under_a_larger_scale_is_accepted` |
| 22 | conformance | `tree.rs::row_22_k1_forbids_any_spx` |
| 23 | unit | `tree.rs::negative_window_edge_is_local_minus_three` |
| 24 | conformance | `tree.rs::row_24_25_group_arity_and_arbitrary_container` |
| 25 | conformance | `tree.rs::row_24_25_group_arity_and_arbitrary_container` |
| 26 | conformance | `tree.rs::row_26_group_near_sits_on_the_new_child` |
| 27 | conformance | `tree.rs::row_27_place_child_does_not_move_the_sibling` |
| 28 | conformance | `tree.rs::row_28_place_child_of_a_nested_group_keeps_the_outer_neighbour` |
| 29 | conformance | `tree.rs::row_29_repeated_entity_recomputes_the_group_union` |
| 30 | conformance | `tree.rs::row_30_arbitrary_without_children_is_bad_arbitrary` |
| 31 | conformance | `tree.rs::row_31_inset_needs_a_window_parent` |
| 32–34 | conformance | `layout.rs::row_32_34_inset_clamps_the_pin_origin` |
| 35–36 | conformance | `layout.rs::row_35_36_inset_shortage_splits_both_gaps` |
| 37 | conformance | `layout.rs::row_37_snap_does_not_beat_the_inset` |
| 38 | conformance | `show_place_end.rs::row_38_begin_with_a_new_size_clears_shows` |
| 39 | conformance | `show_place_end.rs::row_39_show_of_a_parent_shifts_the_child_by_the_delta` |
| 40 | conformance | `show_place_end.rs::row_40_show_of_an_ancestor_moves_the_child_to_its_start` |
| 41 | conformance | `show_place_end.rs::row_41_a_frame_without_show_drops_it` |
| 42 | conformance | `tree.rs::row_42_place_near_pin_sets_a` |
| 43 | conformance | `tree.rs::row_43_place_group_is_bad_parent` |
| 44 | conformance | `tree.rs::row_44_place_entity_sets_size_and_keeps_align` |
| 45 | conformance | `tree.rs::row_45_place_entity_smaller_than_the_image_overflows` |
| 46 | conformance | `tree.rs::row_46_group_cannot_hold_an_arbitrary_box` |
| 47 | conformance | `store_blit.rs::row_47_drop_of_live_photo_is_unknown_image` |
| 48 | conformance | `show_place_end.rs::row_48_show_clips_a_photo_without_stretching` |
| 49 | conformance | `show_place_end.rs::row_49_show_larger_than_the_image_keeps_one_to_one` |
| 50 | conformance | `tree.rs::row_50_photo_format_must_match_the_store` |
| 51–52 | conformance | `layout.rs::row_51_52_arbitrary_grid_flag` |
| 53 | conformance | `layout.rs::row_53_nested_arbitrary_keeps_its_own_box` |
| 54–55 | conformance | `layout.rs::row_54_55_nested_arbitrary_limits` |
| 56 | conformance | `layout.rs::row_56_new_arbitrary_parent_must_already_hold_the_id` |
| 57 | conformance | `tree.rs::row_57_place_nested_arbitrary_uses_the_rect` |
| 58 | conformance | `tree.rs::row_58_place_nested_arbitrary_outside_the_parent_overflows` |
| 59 | conformance | `show_place_end.rs::row_59_show_of_a_nested_arbitrary_shifts_children` |
| 60 | conformance | `tree.rs::row_60_remove_the_only_arbitrary_child_is_bad_arbitrary` |
| 61 | conformance | `tree.rs::row_61_transfer_keeps_the_absolute_pixel` |
| 62 | conformance | `tree.rs::row_62_photo_needs_a_stored_image` |
| 63 | conformance | `tree.rs::row_63_vector_needs_verbs` |
| 64 | typed | `Flat` всегда несёт `color`; `tree.rs::row_64_flat_color_is_written_to_the_frame` |
| 65 | typed | `Entity.edges` обязателен в контракте |
| 66 | typed | `Fill.rule` обязателен; `tree.rs::row_66_vector_branch_needs_its_parameters` (ветки и `BadStroke`) |
| 67 | typed | `Stroke.width` обязателен; `width = 0` → `vector_stroke.rs::stroke_zero_width_is_bad_stroke` |
| 68 | conformance | `tree.rs::row_68_place_pin_zero_inverts_the_fraction` |
| 69 | conformance | `tree.rs::row_69_place_uses_the_live_window_near` |
| 70 | conformance | `store_blit.rs::row_70_blit_src_includes_width` |
| 71 | conformance | `store_blit.rs::row_71_empty_src_with_negative_x1_is_no_op` |
| 72 | conformance | `layout.rs::row_72_threshold_40_wins_over_0` |
| 73 | conformance | `layout.rs::row_73_one_column_short_falls_back_to_threshold_0` |
| 74 | conformance | `layout.rs::row_74_equal_thresholds_keep_the_first` |
| 75 | conformance | `layout.rs::row_75_current_outside_the_pair_picks_the_smallest_id` |
| 76 | conformance | `layout.rs::row_76_more_rows_break_equal_columns` |
| 77 | conformance | `state_frame.rs::row_77_snapshot_before_begin` |
| 78 | conformance | `state_frame.rs::row_78_read_pixels_and_clip_push_before_begin` |
| 79 | conformance | `state_frame.rs::row_79_end_twice_without_begin` |
| 80 | conformance | `state_frame.rs::row_80_drawing_after_end` |
| 81 | conformance | `state_frame.rs::row_81_read_pixels_and_snapshot_after_end` |
| 82 | conformance | `vector_fill.rs::row_82_line_after_close_is_bad_path` |
| 83 | conformance | `store_blit.rs::row_83_short_upload_bytes_keep_the_store` |
| 84 | conformance | `meta_spx_lattice.rs::row_84_pin_outside_the_triple_is_bad_anchor` |
| 85 | conformance | `meta_spx_lattice.rs::row_85_lattice_step_zero_is_bad_cell` |
| 86 | conformance | `vector_fill.rs::row_86_measure_rectangle` |
| 87 | conformance | `vector_stroke.rs::row_87_measure_outside_stroke_includes_the_band` |
| 88 | conformance | `vector_stroke.rs::row_88_measure_covers_miter_arc_and_square_cap`, `fixtures.rs::row_88_miter_45_bytes_are_frozen`, `fixtures.rs::row_88_miter_45_measure_is_frozen` |
| 89 | conformance | `vector_fill.rs::row_89_measure_empty_path_is_bad_path` |
| 90 | conformance | `vector_fill.rs::row_90_coverage_of_one_512th_is_one` |
| 91 | conformance | `layout.rs::row_91_zero_uses_the_canonical_origin` |
| 92 | conformance | `tree.rs::row_92_builtin_reference_waits_for_begin` |
| 93 | conformance | `tree.rs::row_93_defined_reference_accepts_entities_before_begin` |
| 94 | conformance | `layout.rs::row_94_local_zero_paints_on_the_first_primary_line` |
| 95 | conformance | `layout.rs::row_95_far_pin_puts_the_edge_on_the_line` |
| 96 | unit | `tree.rs::reference_change_clears_shows` (смена эталона недостижима без `Begin`, который сам чистит `Show`) |
| 97 | conformance | `layout.rs::row_97_pixel_ratio_does_not_change_the_layout` |
| 98 | conformance | `color.rs::row_98_premultiply_holds_for_every_pair`, `color.rs::row_98_over_holds_for_every_channel_pair` |
| 99 | conformance | `color.rs::row_99_straight_holds_for_every_valid_pair` |
| 100 | conformance | `frame_fill.rs::row_100_opaque_fill_rect_bytes` |
| 101 | conformance | `vector_fill.rs::row_101_path_rectangle_matches_fill_rect`, `vector_fill.rs::row_101_rect_paints_the_pixel_range_only` |
| 102 | conformance | `vector_fill.rs::row_102_fill_path_without_close_equals_with_close` |
| 103 | unit | `vector.rs::quad_not_split` |
| 104 | unit | `vector.rs::quad_splits_and_first_split_is_exact` |
| 105 | conformance | `layout.rs::row_105_snap_near_pin_goes_to_the_lower_line` |
| 106 | conformance | `layout.rs::row_106_snap_far_pin_goes_to_the_upper_line` |
| 107 | conformance | `layout.rs::row_107_snap_centre_breaks_the_tie_down` |
| 108 | conformance | `layout.rs::row_108_snap_counts_from_the_parent_near` |
| 109 | conformance | `store_blit.rs::row_109_area_two_by_one` |
| 110 | conformance | `store_blit.rs::row_110_area_tint_channel_one` |
| 111 | conformance | `vector_stroke.rs::row_111_inside_stroke_is_a_ring_with_empty_interior` |
| 112 | conformance | `vector_stroke.rs::row_112_outside_band_lies_beyond_the_contour` |
| 113 | conformance | `vector_fill.rs::row_113_half_covered_pixel_is_alpha_128` |
| 114 | conformance | `vector_fill.rs::row_114_shallow_edge_area_is_fifteen_sixteenths` |
| 115 | conformance | `vector_fill.rs::row_115_exact_area_is_not_midpoint_sampling` |
| 116 | conformance | `vector_fill.rs::row_116_half_coverage_scales_the_color_alpha` |
| 117 | conformance | `state_frame.rs::row_117_clip_push_narrows_the_frame` |
| 118 | conformance | `state_frame.rs::row_118_33rd_clip_push_overflows` |
| 119 | conformance | `state_frame.rs::row_119_clip_pop_underflow` |
| 120 | invariant | `bench.rs::row_120_146_one_frame_buffer_and_benchmarks`, `frame.rs::same_size_begin_reuses_buffer`, `vector.rs::raster_scratch_is_one_row`, `store.rs::store_allocates_only_on_a_successful_upload` |
| 121 | conformance | `store_blit.rs::row_121_store_bytes_are_not_premultiplied_twice` |
| 122 | conformance | `store_blit.rs::row_122_rgb_tint_channel` |
| 123 | conformance | `store_blit.rs::row_123_rgb_tint_alpha` |
| 124 | conformance | `store_blit.rs::row_124_blend_src_replaces` |
| 125 | conformance | `store_blit.rs::row_125_blend_clear_zeroes` |
| 126 | conformance | `store_blit.rs::row_126_alpha8_stays_coverage` |
| 127 | conformance | `store_blit.rs::row_127_rgba_tint_example` |
| 128 | conformance | `vector_fill.rs::row_128_even_odd_keeps_the_hole` |
| 129 | conformance | `vector_fill.rs::row_129_nonzero_fills_the_hole` |
| 130 | conformance | `vector_fill.rs::row_130_same_winding_bands_nonzero_paints_evenodd_does_not` |
| 131 | conformance | `vector_fill.rs::row_131_reversed_band_cancels_nonzero` |
| 132 | conformance | `fixtures.rs::row_132_bowtie_bytes_are_frozen`, `vector_fill.rs::row_132_bow_tie_cover_sum_is_fifty_squares` |
| 133 | conformance | `layout.rs::row_133_generation_waits_for_new_inputs_and_end_repaints` |
| 134 | unit | `vector.rs::quad_splits_and_first_split_is_exact` |
| 135 | unit | `vector.rs::miter_limit_boundary_is_inclusive` |
| 136 | unit | `vector.rs::miter_limit_boundary_is_inclusive` |
| 137 | conformance | `vector_stroke.rs::row_137_square_cap_extends_but_butt_does_not`, `vector_stroke.rs::row_137_start_cap_is_drawn` |
| 138 | unit | `vector.rs::round_arc_quarter_gives_one_split` |
| 139 | unit | `vector.rs::q16_rounding_is_to_nearest_ties_away` |
| 140 | conformance | `tree.rs::row_140_other_reference_ids_are_unknown_nodes` |
| 141 | conformance | `tree.rs::row_141_new_node_with_an_id_from_another_reference_is_bad_parent` |
| 142 | conformance | `tree.rs::row_142_repeat_entity_replaces_fields_and_keeps_order` |
| 143 | conformance | `tree.rs::row_143_group_with_a_parent_outside_children_is_bad_parent` |
| 144 | conformance | `tree.rs::row_144_redefine_clears_only_its_own_tree` |
| 145 | conformance | `show_place_end.rs::row_145_repeated_show_keeps_the_same_rectangles` |
| 146 | invariant | `lib.rs::one_end_draws_the_tree_once`, `frame.rs::draw_tree_counts_one_pass`, `bench.rs::row_120_146_one_frame_buffer_and_benchmarks` |
| 147 | conformance | `store_blit.rs::row_147_crisp_and_area_agree_on_equal_sizes` |
| 148 | conformance | `state_frame.rs::row_148_two_begins_do_not_keep_pixels` |
| 149 | conformance | `meta_spx_lattice.rs::row_149_frame_and_canon_sides` |
| 150 | conformance | `meta_spx_lattice.rs::row_150_image_sides` |
| 151 | conformance | `vector_fill.rs::row_151_65537_vertices_is_bad_path` |
| 152 | conformance | `vector_fill.rs::row_152_coordinate_over_the_limit_is_overflow` |
| 153 | conformance | `store_blit.rs::row_153_image_id_zero` |
| 154 | conformance | `store_blit.rs::row_154_image_missing_from_store` |
| 155 | conformance | `tree.rs::row_155_second_transition_in_a_frame_is_busy` |
| 156 | conformance | `tree.rs::row_156_missing_reference_does_not_spend_the_transition` |
| 157 | conformance | `state_frame.rs::row_157_error_keeps_state_and_bytes` |
| 158 | conformance | `meta_spx_lattice.rs::row_158_crate_has_no_dependencies`; сборка хоста и wasm32 — CI job `fgce-wasm` (`cargo check --target wasm32-unknown-unknown`, `scripts/check-standalone.ps1`) |
| 159 | conformance | `meta_spx_lattice.rs::row_159_portable_copy_has_no_workspace_inheritance`; standalone-сборка — `scripts/check-standalone.ps1` в CI job `fgce-wasm` |

## Вспомогательные тесты

Тесты без номера строки проверяют контрактные инварианты вокруг строки:

- `show_place_end.rs::show_and_place_reject_empty_rectangles` — `BadCell` для `Show`/`Place` (§4.7, строка 41).
- `show_place_end.rs::reference_switch_shows_only_the_new_tree` — смена эталона отдаёт только новое дерево (строка 96).
- `vector_stroke.rs::stroke_inside_rejects_an_open_contour` — `BadPath` для `Inside` по незамкнутому контуру (§8.4, строка 111).
- `vector_stroke.rs::stroke_zero_width_is_bad_stroke` — `width = 0` (строка 67).
- `vector_stroke.rs::stroke_measure_rounds_like_the_spec_bounds` — `Measure` внутренней обводки (§8.4).
- `vector_fill.rs::path_rectangle_rect_helper_matches_spec_bounds` — границы `Measure` на отрицательных координатах.
- `frame_fill.rs::fill_rect_blend_src_and_clear` — `FillRect` с `Blend::Src` и `Blend::Clear` (§6).
- `color.rs::row_98_pixel_format_of_the_table_is_rgba8` — формат `Info`.
- `fuzz.rs::err_does_not_move_state_or_bytes` — 10 000 детерминированных последовательностей; после `Err` отпечаток состояния и байтов не меняется.
- `fixtures.rs::regen_fixtures` — `#[ignore]`, регенерация замороженных байтов.

## Аудит §11

Каждый пункт «Оптимизаций, которые обязательны» с доказательством. Где теста нет,
доказательство — конкретный код и его гейт.

| §11 | Доказательство |
|-----|----------------|
| 1. Непрозрачный ряд — плотная запись | `span.rs::write_solid` пишет блоками `u128`; `span.rs::opaque_write_is_dense`, `frame_fill.rs::row_100_opaque_fill_rect_bytes` |
| 2. Равные размеры `Blit` — копирование строки | `blit.rs::can_copy_row`/`copy_rows`; `blit.rs::equal_sizes_take_the_row_copy_path`, `blit.rs::area_equal_sizes_copies_source`, `store_blit.rs::row_147_crisp_and_area_agree_on_equal_sizes` |
| 3. Ось-параллельные заливка и обводка — `span` | `vector.rs::fill_orthogonal` и ветка `outline.is_orthogonal()` в обводке; `vector.rs::path_rectangle_matches_fill_rect`, `vector.rs::fill_without_close_equals_with_close` |
| 4. Альфа 0/255 и покрытие до выбора | `span.rs::transparent_source_does_not_read_destination`, `span.rs::opaque_write_is_dense`, `span.rs::full_cover_with_half_alpha_stays_half`, `vector.rs::triangle_half_coverage_with_alpha` |
| 5. Store переживает `Begin`, без повторной конвертации | `store.rs::repeat_upload_replaces_and_drop_forgets`, `store_blit.rs::row_121_store_bytes_are_not_premultiplied_twice` (два `Begin` подряд) |
| 6. Буфер кадра переживает `Begin` того же размера | `frame.rs::same_size_begin_reuses_buffer` (`allocations` не растёт, указатель тот же) |
| 7. Строка аккумулятора и стек клипа вне пиксельного цикла | `vector.rs::raster_scratch_is_one_row`; `frame.rs::clip_stack_limits`; одна строка `RasterScratch` живёт в `Engine` (`fit` на `Begin`, `ensure` на путь), не создаётся на путь и не на пиксель |
| 8. Паддинг 64 и выравнивание указателя | `frame.rs::stride_and_alignment`, `frame.rs::end_borrows_buffer_and_state_moves` |
| 9. Нет замка, канала и аллокации в `span` | функции рисования `span` (`paint`, `paint_premul`, `copy_row_premul`, `write_*`) принимают только `&mut [u8]` и срезы; `straight_row` копирует в `Vec` вызывающего для `ReadPixels` (§7); нет `Mutex`/`mpsc`; `cargo clippy --all-targets -D warnings` чист |
| 10. Решётка — два `count` и два `origin`, без массива клеток | `contract.rs::Lattice`, `lattice.rs::window_90`, `lattice.rs::window_91`, `meta_spx_lattice.rs::row_05`–`row_10` |
| 11. Живой прямоугольник — только с поколением; `End` после `Begin` пишет снова | `layout.rs::row_133_generation_waits_for_new_inputs_and_end_repaints`, `tree.rs::snapshot_generation_waits_for_new_inputs`, `tree.rs::end_repaints_after_a_same_size_begin` |

**Решение №61:** в `0.1.0` площадь трапеций считается в `f64`; аккумулятор
`i128` перенесён за `0.1.0`. Все §12-значения и замороженные байты совпадают.
Закон — `docs/questions.md` №61 и `docs/fgce.md` §8.3.

## Фикстуры

`fixtures/bowtie.bin` и `fixtures/miter_45.bin` — байты кадра, сгенерированные
один раз эталонной реализацией (D8). Ручная правка запрещена; регенерация —
только `--ignored` тестом с ревью диффа.

## Границы

- Пакет не импортирует внутренности `fgce`: только `fgce::*` и `Harness`.
- `Harness::pixel` читает `ReadPixels` + `Straight`; `pixel_premul` — `Premul`
  для проверки байтов кадра (§6).
- Внутренние строки (23, 103, 104, 134–136, 138, 139) недостижимы через
  `submit` и живут unit-тестами в `crates/fgce/src`.
