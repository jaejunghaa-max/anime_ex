// Environment bindings + typed D1 rows + the minimal slice of Discord's
// interaction payloads this bot touches. Raw fetch everywhere (spec §2.4) —
// no SDK types.

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  TOKEN_ENC_KEY: string;
  MAX_PARTICIPANTS?: string;
  JOB_BATCH?: string;
  REMINDERS_PER_TICK?: string;
  ANILIST_FALLBACK?: string;
  SFW_ONLY?: string;
}

export interface Cfg {
  maxParticipants: number;
  jobBatch: number;
  remindersPerTick: number;
  anilistFallback: boolean;
  sfwOnly: boolean;
}

export function cfgOf(env: Env): Cfg {
  const int = (v: string | undefined, d: number) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxParticipants: int(env.MAX_PARTICIPANTS, 100),
    jobBatch: int(env.JOB_BATCH, 5),
    remindersPerTick: int(env.REMINDERS_PER_TICK, 30),
    anilistFallback: (env.ANILIST_FALLBACK ?? 'true') !== 'false',
    sfwOnly: (env.SFW_ONLY ?? 'true') !== 'false',
  };
}

// ---------------------------------------------------------------- D1 rows

export interface GuildRow {
  guild_id: string;
  manager_channel_id: string | null;
  participant_channel_id: string | null;
  manager_msg_id: string | null;
  participant_msg_id: string | null;
  manager_role_id: string | null;
  google_refresh_token_enc: string | null;
  google_email: string | null;
  created_at: number;
}

export type EventState =
  | 'DRAFTING' | 'SIGNUP_OPEN' | 'MATCHING' | 'LAUNCHING'
  | 'RUNNING' | 'CLOSING' | 'REVEALED';

export interface EventRow {
  event_id: number;
  guild_id: string;
  state: EventState;
  topic: string | null;
  tz: string | null;
  signup_deadline: number | null;
  auto_stop: number;
  signup_banner_flipped: number;
  review_deadline: number | null;
  reminder_days: string;
  dm_mirror: number;
  sheet_id: string | null;
  sheet_gid: number | null;
  gallery_posted: number;
  loop_status: 'none' | 'shuffled' | 'manual';
  validated_at: number | null;
  count_panel_at: number;
  panel_dirty: number;
  created_at: number;
  updated_at: number;
}

export interface FormItem {
  item_id: number;
  event_id: number;
  position: number;
  label: string;
  type: 'FIB' | 'MCQ';
  options_json: string | null;
  visible_to_recommender: number;
}

export interface SignupRow {
  signup_id: number;
  event_id: number;
  user_id: string;
  display_name: string;
  mal_id: number;
  anime_title: string;
  anime_title_en: string | null;
  anime_year: number | null;
  anime_type: string | null;
  anime_episodes: number | null;
  anime_url: string;
  anime_image: string | null;
  answers_json: string;
  row_order: number | null;
  thread_id: string | null;
  doc_id: string | null;
  doc_url: string | null;
  perm_id: string | null;
  dm_channel_id: string | null;
  assignment_posted: number;
  doc_readonly: number;
  reveal_posted: number;
  synced_at: number | null;
  template_chars: number;
  doc_missing: number;
  wrote: number;
  last_edited: number | null;
  char_count: number;
  created_at: number;
  updated_at: number;
}

export type JobKind = 'launch' | 'close' | 'sync' | 'finish';

export interface JobRow {
  id: number;
  event_id: number;
  kind: JobKind;
  payload_json: string;
  created_at: number;
  done_at: number | null;
  attempts: number;
  last_error: string | null;
  attempted_at: number | null;
}

export interface DraftRow {
  event_id: number;
  user_id: string;
  step: 'A_DONE' | 'PICKED' | 'B_DONE';
  keyword: string | null;
  partial_answers_json: string | null;
  candidates_json: string | null;
  chosen_json: string | null;
  expires_at: number;
}

export interface ReminderRow {
  id: number;
  event_id: number;
  user_id: string;
  kind: 'review' | 'manual';
  due_at: number;
  sent_at: number | null;
}

// ------------------------------------------------------- Discord payloads

export const IT = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL: 5 } as const;

// Interaction callback types (§13.1)
export const RT = {
  PONG: 1,
  MESSAGE: 4,
  DEFER_MESSAGE: 5,
  DEFER_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const EPHEMERAL = 64;

export interface DUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DMember {
  user: DUser;
  nick?: string | null;
  roles: string[];
  permissions: string;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: DMember;
  user?: DUser;
  message?: { id: string; flags?: number };
  data?: InteractionData;
}

export interface InteractionData {
  // command
  id?: string;
  name?: string;
  options?: Array<{ name: string; type: number; value?: unknown; options?: unknown[] }>;
  // component
  custom_id?: string;
  component_type?: number;
  values?: string[];
  // modal
  components?: ModalNode[];
}

// Modal submit tree: Labels (18) wrapping one component, or legacy Action
// Rows (1) wrapping several. Flattened by `modalFields`.
export interface ModalNode {
  type: number;
  component?: ModalLeaf;
  components?: ModalLeaf[];
}
export interface ModalLeaf {
  type: number;
  custom_id: string;
  value?: string;
  values?: string[];
}

export function modalFields(nodes: ModalNode[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes ?? []) {
    const leaves = n.component ? [n.component] : (n.components ?? []);
    for (const leaf of leaves) {
      if (!leaf?.custom_id) continue;
      if (leaf.values) out.set(leaf.custom_id, leaf.values[0] ?? '');
      else out.set(leaf.custom_id, leaf.value ?? '');
    }
  }
  return out;
}
