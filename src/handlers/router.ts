// Interaction router (§12 custom_id registry, §13 handling rules). Thin by
// design: verify happened in index.ts; here it's parse → guards → dispatch.

import type { Cfg, Env, Interaction } from '../types';
import { IT } from '../types';
import { respond } from '../discord';
import { getEventByGuild, getGuild } from '../db';
import { displayNameOf, shortRef } from '../util';
import { HCtx, managerOnly, stale } from './common';
import { handleSetup, isAdmin } from './setup';
import * as mgr from './manager';
import * as su from './signup';

// Actions any member may use; everything else under ax:/axm: is manager-only (§13.2).
const PARTICIPANT_ACTIONS = new Set([
  'signup', 'signup_pick', 'signup_again', 'signup_cont', 'signup_confirm', 'signup_restart',
  'edit_signup', 'withdraw', 'score', 'cancel',
]);
const PARTICIPANT_MODALS = new Set(['signup_a', 'signup_b', 'score']);

export async function routeInteraction(
  env: Env, cfg: Cfg, ec: ExecutionContext, i: Interaction,
): Promise<Response> {
  if (i.type === IT.PING) return respond.pong();

  try {
    return await dispatch(env, cfg, ec, i);
  } catch (e) {
    const ref = shortRef();
    console.error(`[${ref}] interaction failed`, e instanceof Error ? `${e.message}\n${e.stack}` : e);
    return respond.ephemeral({ content: `⚠ Something went wrong (\`${ref}\`) — try again.` });
  }
}

async function dispatch(env: Env, cfg: Cfg, ec: ExecutionContext, i: Interaction): Promise<Response> {
  if (!i.guild_id || !i.member) {
    return respond.ephemeral({ content: 'This bot only works inside a server.' });
  }

  if (i.type === IT.COMMAND) {
    if (i.data?.name === 'setup') return handleSetup(env, cfg, ec, i);
    return respond.ephemeral({ content: 'Unknown command.' });
  }

  const customId = i.data?.custom_id ?? '';
  const [ns, action = '', arg = ''] = customId.split(':');
  const isModal = i.type === IT.MODAL;
  if ((ns !== 'ax' && ns !== 'axm') || !action) {
    return respond.ephemeral({ content: 'Unknown control.' });
  }

  const guild = await getGuild(env, i.guild_id);
  if (!guild) {
    return respond.ephemeral({ content: '⚙ Run `/setup init` first (needs Administrator).' });
  }
  const event = await getEventByGuild(env, i.guild_id);
  const isManager = isAdmin(i) ||
    (guild.manager_role_id !== null && i.member.roles.includes(guild.manager_role_id));

  const c: HCtx = {
    env, cfg, ec, i, guild, event,
    userId: i.member.user.id,
    displayName: displayNameOf(i.member),
    isManager,
  };

  const participant = isModal ? PARTICIPANT_MODALS.has(action) : PARTICIPANT_ACTIONS.has(action);
  if (!participant && !isManager) return managerOnly();

  if (isModal) {
    switch (action) {
      case 'basics': return mgr.basicsSubmit(c);
      case 'item': return mgr.itemSubmit(c, arg);
      case 'grouping': return mgr.groupingSubmit(c);
      case 'launch': return mgr.launchSubmit(c);
      case 'signup_a': return su.signupModalA(c);
      case 'signup_b': return su.signupModalB(c);
      case 'score': return su.scoreSubmit(c);
      default: return stale(c, 'This form is from an older version.');
    }
  }

  switch (action) {
    // shared
    case 'cancel': return mgr.cancel();
    // IDLE / any
    case 'new_event': return mgr.newEvent(c);
    case 'google': return mgr.connectGoogle(c);
    // DRAFTING
    case 'basics': return mgr.basicsModal(c);
    case 'item_add': return mgr.itemAdd(c);
    case 'item_menu': return mgr.itemMenu(c);
    case 'item_pick': return mgr.itemPick(c);
    case 'item_edit': return mgr.itemEditModal(c, arg);
    case 'item_up': return mgr.itemMove(c, arg, 'up');
    case 'item_down': return mgr.itemMove(c, arg, 'down');
    case 'item_del': return mgr.itemDelete(c, arg);
    case 'open': return arg === 'go' ? mgr.openSignupsGo(c) : mgr.openSignups(c);
    case 'discard': return arg === 'go' ? mgr.discardGo(c) : mgr.discard(c);
    // SIGNUP_OPEN / MATCHING (manager)
    case 'view_signups': return mgr.viewSignups(c);
    case 'stop': return arg === 'go' ? mgr.stopSignupsGo(c) : mgr.stopSignups(c);
    case 'reopen': return arg === 'go' ? mgr.reopenSignupsGo(c) : mgr.reopenSignups(c);
    case 'shuffle': return mgr.shuffle(c);
    case 'grouping': return mgr.groupingModal(c);
    case 'validate': return mgr.validate(c);
    case 'rm_confirm': return mgr.removalConfirm(c, arg);
    case 'rm_restore': return mgr.removalRestore(c, arg);
    case 'launch': return arg === 'go' ? mgr.launchGo(c) : mgr.launchModal(c);
    // RUNNING (manager)
    case 'view_event': return mgr.viewEvent(c);
    case 'remind': return arg === 'go' ? mgr.remindNowGo(c) : mgr.remindNow(c);
    case 'close':
      if (arg === 'gallery') return mgr.closeGo(c, true);
      if (arg === 'quiet') return mgr.closeGo(c, false);
      return mgr.closeReviews(c);
    // REVEALED (manager)
    case 'finish': return arg === 'go' ? mgr.finishGo(c) : mgr.finish(c);
    // any non-IDLE state (manager)
    case 'abort': return arg === 'go' ? mgr.abortGo(c) : mgr.abort(c);
    // participant wizard
    case 'signup': return su.signupStart(c, false);
    case 'edit_signup': return su.signupStart(c, true);
    case 'signup_pick': return su.signupPick(c);
    case 'signup_cont': return su.signupContinue(c);
    case 'signup_again': return su.signupAgain(c);
    case 'signup_restart': return su.signupRestart(c);
    case 'signup_confirm': return su.signupConfirm(c);
    case 'score': return su.scoreModal(c);
    case 'withdraw': return arg === 'go' ? su.withdrawGo(c) : su.withdraw(c);
    default:
      return stale(c, 'This control is from an older version of the panel.');
  }
}
