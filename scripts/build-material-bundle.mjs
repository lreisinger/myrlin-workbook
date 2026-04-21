#!/usr/bin/env node
/**
 * Build script: generates public/vendor/material-icons.bundle.js
 * Reads curated icons from @material-icons/svg (baseline/filled variant),
 * resizes to 14×14, adds fill="currentColor", and writes a plain JS bundle
 * that sets window.__materialIcons and window.__materialIconCategories.
 *
 * Icon names are stored with a "mi/" prefix when used in ws.icon so they
 * can coexist with Lucide icon names without collision.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ICONS_DIR = resolve(ROOT, 'node_modules/@material-icons/svg/svg');
const OUT = resolve(ROOT, 'src/web/public/vendor/material-icons.bundle.js');

// ── Curated icon list ─────────────────────────────────────────────────────────
// Format: { category: [icon-name, ...] }  (all baseline/filled variant)
const ICON_CATEGORIES = {
  'Folders & Files': [
    'folder', 'folder_open', 'folder_shared', 'folder_zip', 'folder_special',
    'folder_copy', 'create_new_folder', 'snippet_folder',
    'description', 'article', 'note', 'notes', 'drafts', 'edit_note',
    'insert_drive_file', 'file_copy', 'attach_file', 'attach_email',
    'book', 'menu_book', 'auto_stories', 'library_books',
  ],
  'Code & Dev': [
    'code', 'data_object', 'data_array', 'terminal', 'developer_mode',
    'api', 'bug_report', 'build', 'construction', 'settings_suggest',
    'integration_instructions', 'functions', 'schema', 'account_tree',
    'alt_route', 'commit', 'merge_type', 'fork_right',
    'memory', 'developer_board', 'electrical_services',
  ],
  'Infrastructure': [
    'storage', 'sd_storage', 'dns', 'cloud', 'cloud_upload', 'cloud_download',
    'cloud_sync', 'cloud_done', 'backup', 'restore',
    'computer', 'laptop', 'phone_android', 'tablet', 'devices',
    'router', 'hub', 'lan', 'cell_tower', 'wifi', 'signal_wifi_4_bar',
    'power', 'bolt', 'cable',
  ],
  'Apps & Tools': [
    'apps', 'dashboard', 'widgets', 'extension', 'handyman', 'hardware',
    'precision_manufacturing', 'tune', 'build_circle', 'home_repair_service',
    'assignment', 'task_alt', 'fact_check', 'rule', 'checklist', 'playlist_add_check',
    'rocket_launch', 'start', 'play_arrow', 'stop_circle',
  ],
  'Design & Art': [
    'palette', 'brush', 'format_paint', 'color_lens', 'design_services',
    'auto_fix_high', 'auto_awesome', 'style', 'format_shapes',
    'crop_free', 'aspect_ratio', 'photo_camera', 'camera_alt',
    'image', 'collections', 'photo_library', 'wallpaper',
    'gradient', 'blur_on', 'motion_photos_on',
  ],
  'Learning & Science': [
    'school', 'science', 'biotech', 'psychology', 'calculate',
    'engineering', 'architecture', 'domain_verification',
    'auto_stories', 'quiz', 'help_outline', 'question_mark',
    'lightbulb', 'tips_and_updates', 'explore',
  ],
  'People & Status': [
    'person', 'group', 'groups', 'manage_accounts', 'supervised_user_circle',
    'star', 'star_border', 'favorite', 'thumb_up', 'emoji_events',
    'workspace_premium', 'military_tech', 'verified', 'new_releases',
    'security', 'lock', 'lock_open', 'key', 'shield', 'admin_panel_settings',
  ],
  'Home & Work': [
    'home', 'house', 'business', 'corporate_fare', 'apartment', 'domain',
    'store', 'storefront', 'shopping_cart', 'local_mall',
    'location_on', 'place', 'map', 'near_me', 'travel_explore',
    'work', 'business_center', 'badge', 'meeting_room', 'weekend',
  ],
  'Media & Comms': [
    'email', 'mail', 'chat', 'forum', 'comment', 'message', 'sms',
    'notifications', 'campaign', 'announcement', 'record_voice_over',
    'music_note', 'library_music', 'headphones', 'headset_mic',
    'videocam', 'video_library', 'live_tv', 'cast',
    'photo', 'photo_album', 'slideshow',
  ],
  'Data & Analytics': [
    'analytics', 'bar_chart', 'show_chart', 'pie_chart', 'stacked_line_chart',
    'trending_up', 'trending_down', 'leaderboard', 'insights',
    'table_chart', 'grid_view', 'view_list', 'view_module',
    'data_usage', 'query_stats', 'ssid_chart',
  ],
  'Finance & Commerce': [
    'payments', 'account_balance', 'account_balance_wallet', 'savings',
    'currency_exchange', 'sell', 'price_check', 'receipt_long',
    'attach_money', 'money_off', 'credit_card', 'point_of_sale',
  ],
  'Nature & Life': [
    'park', 'eco', 'nature', 'forest', 'grass', 'yard',
    'wb_sunny', 'nights_stay', 'cloud', 'thunderstorm', 'ac_unit', 'water',
    'pets', 'cruelty_free',
    'local_cafe', 'local_dining', 'fastfood', 'restaurant',
    'fitness_center', 'sports_esports', 'sports_soccer', 'directions_run',
  ],
};

// ── SVG processor ─────────────────────────────────────────────────────────────
function processSvg(raw) {
  return raw
    // Resize to 14×14
    .replace(/width="24"/, 'width="14"')
    .replace(/height="24"/, 'height="14"')
    // Make color inherit from CSS (Material SVGs have no explicit fill by default,
    // so without this they render black always)
    .replace('<svg ', '<svg fill="currentColor" ');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const icons = {};
const categories = {};
const skipped = [];

for (const [category, names] of Object.entries(ICON_CATEGORIES)) {
  const catIcons = [];
  for (const name of names) {
    if (icons[name]) { catIcons.push(name); continue; } // de-dup

    const svgPath = resolve(ICONS_DIR, name, 'baseline.svg');
    if (!existsSync(svgPath)) {
      skipped.push(name);
      continue;
    }
    try {
      const raw = readFileSync(svgPath, 'utf8').trim();
      icons[name] = processSvg(raw);
      catIcons.push(name);
    } catch {
      skipped.push(name);
    }
  }
  if (catIcons.length > 0) categories[category] = catIcons;
}

// ── Output ────────────────────────────────────────────────────────────────────
mkdirSync(resolve(ROOT, 'src/web/public/vendor'), { recursive: true });

const output = `/* Material Icons bundle — generated by scripts/build-material-bundle.mjs */
/* Includes ${Object.keys(icons).length} icons from @material-icons/svg (baseline variant) */
/* Icon names are stored as "mi/<name>" in workspace records to avoid Lucide collisions */
(function() {
  window.__materialIcons = ${JSON.stringify(icons)};
  window.__materialIconCategories = ${JSON.stringify(categories)};
  document.dispatchEvent(new Event('material-icons-ready'));
})();
`;

writeFileSync(OUT, output);
console.log(`✓ Built ${Object.keys(icons).length} Material icons → src/web/public/vendor/material-icons.bundle.js`);
if (skipped.length) console.log(`  Skipped (not found): ${skipped.join(', ')}`);
