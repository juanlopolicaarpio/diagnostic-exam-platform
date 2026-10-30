-- Broaden the visual_assets.asset_type CHECK constraint.
--
-- The old constraint only permitted image | figure | diagram | chart, which made
-- the "any format" figure uploader fail (23514) for PDF / SVG / video / audio /
-- other files. This widens the allowed set to every format the uploader produces
-- and the renderer (VisualAssetPreview) knows how to display.

alter table public.visual_assets
  drop constraint if exists visual_assets_asset_type_check;

alter table public.visual_assets
  add constraint visual_assets_asset_type_check
  check (asset_type in (
    'image', 'figure', 'diagram', 'chart',
    'svg', 'pdf', 'video', 'audio', 'file'
  ));
