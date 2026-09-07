#!/usr/bin/env node
// Registers the /setup command globally and prints the bot invite URL.
// Usage: DISCORD_TOKEN=... DISCORD_APP_ID=... node scripts/register-commands.mjs

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
if (!token || !appId) {
  console.error('Set DISCORD_TOKEN and DISCORD_APP_ID environment variables first.');
  process.exit(1);
}

const commands = [
  {
    name: 'setup',
    description: 'Anime Exchange setup',
    // Visible to Administrators only by default (spec §3.1).
    default_member_permissions: '8',
    dm_permission: false,
    options: [
      { type: 1, name: 'init', description: 'Create the Exchange Manager role, both channels and the pinned panels' },
      { type: 1, name: 'repair', description: 'Re-create missing channels/panels and repaint them from stored state' },
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`Command registration failed: ${res.status}`, await res.text());
  process.exit(1);
}
console.log('✅ Registered /setup (init, repair).');

// Bot install permissions (spec §3.1): Manage Channels, Manage Threads,
// Create Private Threads, Send Messages (+in Threads), Embed Links, Read
// Message History, Manage Messages.
// Dropped as the bot stopped needing them: Mention Everyone (bit 17) in v7.0
// with the @everyone sign-up ping, and Manage Roles (bit 28) in v7.1 with the
// manager role — asking for a permission the bot never uses costs trust at
// install time.
const bits = [4n, 34n, 36n, 11n, 38n, 14n, 16n, 13n]
  .reduce((acc, b) => acc | (1n << b), 0n);
console.log('\nInvite the bot with:');
console.log(`https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${bits}`);
