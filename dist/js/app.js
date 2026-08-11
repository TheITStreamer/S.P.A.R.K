import { initWheel }      from './wheel-tab.js';
import { initGiveaway }   from './giveaway-tab.js';
import { initTimers }     from './timers-tab.js';
import { initTasks }      from './tasks-tab.js';
import { initGoals }      from './goals-tab.js';
import { initCheckins }   from './checkins-tab.js';
import { initSongRequest } from './songrequest-tab.js';
import { initChat }       from './chat-tab.js';
import { initCounters }   from './counters-tab.js';
import { initCredits }    from './credits-tab.js';
import { initDiy }        from './diy-tab.js';
import { initCommands }   from './commands-tab.js';
import { initBroadcast }  from './broadcast-tab.js';
import { initSettings }   from './settings-tab.js';
import { initReauth }     from './reauth.js';
import { initFonts }      from './fonts.js';
import { store, loadFollowerMirror } from './store.js';
import { applyTheme }     from './theme.js';
import { initTabChrome, refreshDisabledBanner, applySavedTabLayout } from './tab-chrome.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ── Sidebar ───────────────────────────────────────────────────────────────────
// Tab selection, collapsing, drag-to-reorder, the Ctrl+K switcher and the
// disabled-tool banner all live in tab-chrome.js — they all have to agree about
// which tab is showing. Runs before the data file is read so the nav exists on
// the first paint; applySavedTabLayout() below fills in the saved order.
initTabChrome();

// ── Global Twitch status header ───────────────────────────────────────────────
export function setHeaderStatus(state, msg){
  const dot  = document.getElementById('twDotHeader');
  const text = document.getElementById('twStatusHeader');
  dot.className  = 'dot' + (state ? ' '+state : '');
  text.textContent = msg;
}

// ── Help System ───────────────────────────────────────────────────────────────
const HELP_CONTENT = {
  wheel: {
    title: 'Wheel',
    html: '<h3>Overview</h3>'
      + '<p>Spin a wheel to pick from a list. Good for viewer giveaways, game picks, or any random decision.</p>'
      + '<h3>Setting Up</h3>'
      + '<ul>'
      + '<li>Type an item and click <strong>Add</strong>, or paste a whole list into the bulk box.</li>'
      + '<li>Drag the handle to reorder items. The + and − buttons on each item raise or lower its odds.</li>'
      + '<li>Save lists and reload them any time from <strong>Saved Lists</strong>.</li>'
      + '<li>Pick a colour theme or paste your own hex colours.</li>'
      + '</ul>'
      + '<h3>Spinning</h3>'
      + '<ul>'
      + '<li>Click <strong>Spin</strong> in the preview column, or let viewers spin it with a channel point redeem.</li>'
      + '<li><strong>Remove winner</strong> takes the winner off the wheel after each spin.</li>'
      + '<li>You can set a sound that plays while the wheel spins, a winner sound, and a chat message that announces the winner.</li>'
      + '</ul>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> at the bottom and add it as a Browser Source in OBS.</p>'
  },
  giveaway: {
    title: 'Giveaway',
    html: '<h3>Overview</h3>'
      + '<p>Run keyword-based giveaways where viewers enter by typing a word in chat.</p>'
      + '<h3>Setting Up</h3>'
      + '<ul>'
      + '<li>Set the <strong>Entry Word</strong>. Viewers type this in chat to enter (e.g. <code>!enter</code>).</li>'
      + '<li>Configure eligibility: sub-only, follower-only, or open to all.</li>'
      + '<li>Allow multiple entries if you want, with a max per viewer and a cooldown between entries.</li>'
      + '<li>Turn on chat responses to confirm entries in chat, with your own wording.</li>'
      + '</ul>'
      + '<h3>Running a Giveaway</h3>'
      + '<ul>'
      + '<li>Click <strong>Open Giveaway</strong> to start accepting entries.</li>'
      + '<li>Click <strong>Close Giveaway</strong> to stop new entries.</li>'
      + '<li>Click <strong>Draw Winner</strong> to pick a random entrant. Every winner from the session stays listed under Status so nothing gets lost when the banner disappears.</li>'
      + '<li>Mods can run it from chat: <code>!word open</code>, <code>!word close</code>, <code>!draw</code> (using your entry word).</li>'
      + '</ul>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS to display the winner announcement on stream.</p>'
  },
  timers: {
    title: 'Timers',
    html: '<h3>Overview</h3>'
      + '<p>Create countdown or count-up timers and show them on stream. You can build them by hand, or have a channel point redeem create a fresh one every time it is used.</p>'
      + '<h3>Creating a Timer by Hand</h3>'
      + '<ul>'
      + '<li>Fill in <strong>New Timer</strong> with a name and a duration, then click <strong>Add Timer</strong>.</li>'
      + '<li>Duration accepts <code>mm:ss</code>, <code>h:mm:ss</code> or <code>d:h:mm:ss</code>.</li>'
      + '<li>Choose <strong>Count down</strong> or <strong>Count up</strong>.</li>'
      + '<li>Pick a Google Font and text colour to match your stream style.</li>'
      + '<li>Optionally set a start sound, an end sound, and an end message that appears on the overlay when the timer runs out.</li>'
      + '<li><strong>Save as Preset</strong> keeps the setup so you can add it again later with one click.</li>'
      + '<li><strong>Auto-resume</strong> remembers where the timer was and picks it back up when SPARK reopens.</li>'
      + '</ul>'
      + '<h3>Starting a Timer</h3>'
      + '<ul>'
      + '<li>Use the Play, Pause and Reset buttons on the timer card.</li>'
      + '<li>Link a <strong>channel point reward</strong> to a timer so redeeming it restarts that timer.</li>'
      + '<li><strong>Any redeem starts this timer</strong> makes it restart on every reward, whichever one was redeemed.</li>'
      + '<li>Chat command <code>!timer &lt;name&gt;</code> restarts a timer by its name.</li>'
      + '</ul>'
      + '<h3>Auto Timers</h3>'
      + '<p>Point a channel point reward at an <strong>Auto Timer</strong> config and each redeem creates its own separate countdown, labelled with whatever the viewer typed. Useful any time you want several things tracked side by side instead of one shared timer that keeps getting restarted.</p>'
      + '<p>You can set up as many configs as you like, one per reward, each with its own title, duration and styling. Click <strong>＋ New Auto Timer</strong> to add one, then <strong>Edit</strong> to open its settings.</p>'
      + '<ul>'
      + '<li><strong>Title</strong> names the config and appears as a coloured tag on every timer it creates, so you can tell at a glance which redeem made which timer.</li>'
      + '<li>The reward must have <strong>Require viewer to enter text</strong> ticked in your Twitch dashboard. That text becomes the timer label, so a redeem with nothing typed is ignored.</li>'
      + '<li><strong>Duration</strong> sets how long every new timer from this config runs for. They always count down.</li>'
      + '<li><strong>Label template</strong> controls the wording. <code>{text}</code> is what the viewer typed, <code>{n}</code> is the timer number, and <code>{title}</code> is the config title.</li>'
      + '<li><strong>When created</strong> chooses between starting the countdown straight away, or leaving it sitting at full until a mod runs <code>!stm</code>.</li>'
      + '<li><strong>Text colour</strong> is what shows on stream. <strong>Tag colour</strong> is the marker used inside SPARK to group timers from this config.</li>'
      + '<li><strong>Max timers from this config</strong> caps how many this one reward can have running. Set it to 0 to let the overall limit be the only cap.</li>'
      + '<li><strong>Remove once finished</strong> clears the timer roughly ten seconds after it hits zero, which is long enough for the end message to be seen.</li>'
      + '<li><strong>Test</strong> creates a sample timer so you can check the styling without spending a redeem.</li>'
      + '<li>Untick <strong>Enabled</strong> to park a config without deleting it. Its reward stops creating timers until you turn it back on.</li>'
      + '</ul>'
      + '<h3>Settings Shared by Every Config</h3>'
      + '<ul>'
      + '<li><strong>Overall limit</strong> caps the combined total across all configs, so one busy reward cannot bury the overlay. Both this and the per config limit have to have room before a new timer is created. Set it to 0 for no limit.</li>'
      + '<li><strong>Show numbers on the overlay</strong> puts the timer number in front of each label on stream. Leave it off if you only want numbers visible to you in SPARK.</li>'
      + '<li><strong>Confirm commands in chat</strong> posts a short reply when a command runs, naming the config when a limit is hit. Turn it off for a quieter chat.</li>'
      + '</ul>'
      + '<p>If two configs point at the same reward, only the first one in the list creates a timer.</p>'
      + '<h3>Timer Numbers</h3>'
      + '<p>Every active timer has a number shown in gold on its card and in the preview column. Numbers follow list position, so the newest timer is always last. Remove one and the timers below it shift up to close the gap, which keeps the list reading 1, 2, 3 with nothing missing.</p>'
      + '<p>There is a single run of numbers across the whole list, whichever config created each timer, and it includes timers you added by hand. That way a number always means one thing and your mods never have to say which set they meant.</p>'
      + '<h3>Chat Commands</h3>'
      + '<p>These work for the <strong>broadcaster and mods only</strong>. Anyone else typing them is ignored with no reply, so viewers cannot interfere.</p>'
      + '<ul>'
      + '<li><code>!stm &lt;n&gt;</code> starts or resumes timer n.</li>'
      + '<li><code>!ptm &lt;n&gt;</code> pauses timer n where it stands.</li>'
      + '<li><code>!rtm &lt;n&gt;</code> resets timer n to its full duration and starts it running again.</li>'
      + '<li><code>!dtm &lt;n&gt;</code> removes timer n and renumbers the rest.</li>'
      + '<li><code>!ctm</code> clears every active timer at once. This includes timers you added by hand, not only the ones from a redeem.</li>'
      + '<li>Use <code>all</code> in place of a number with <code>!stm</code>, <code>!ptm</code> and <code>!rtm</code> to hit every timer in one go.</li>'
      + '</ul>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS to show timers on stream. Auto timers appear in this same overlay alongside the rest, stacked in number order.</p>'
      + '<p>A timer that has finished stays on screen for ten seconds so its end message can be read, then fades out.</p>'
  },
  tasks: {
    title: 'Tasks (Co-work)',
    html: '<h3>Overview</h3>'
      + '<p>A shared to do list for you and your viewers. Your tasks show at the top in gold. Viewer tasks are grouped below by username.</p>'
      + '<h3>Chat Commands</h3>'
      + '<ul>'
      + '<li><code>!task add &lt;text&gt;</code> adds a task</li>'
      + '<li><code>!task done &lt;number&gt;</code> marks a task complete</li>'
      + '<li><code>!task remove &lt;name&gt;</code> removes a user\'s tasks (mods only)</li>'
      + '<li><code>!task clear</code> clears the whole list (mods only)</li>'
      + '</ul>'
      + '<h3>Your Tasks</h3>'
      + '<p>Type in the <strong>Add host task</strong> box and press Enter. You can set how many tasks viewers, followers, and subs are each allowed to add.</p>'
      + '<h3>Pomodoro Timer</h3>'
      + '<p>A pomodoro is a simple focus method: work for a set time, then take a short break. After a few rounds you take a longer break. The name comes from a tomato shaped kitchen timer.</p>'
      + '<ul>'
      + '<li>Turn it on with the <strong>Enable Pomodoro timer</strong> checkbox.</li>'
      + '<li>Pick a mode like Classic 25/5 or Deep Work 50/10, or make your own with any work length, break length, and number of rounds.</li>'
      + '<li><strong>Focus task</strong> lets you pick one of your own tasks to show on the overlay while you work. You need at least one host task in the list first.</li>'
      + '<li>Use <strong>Pause</strong>, <strong>+5 min</strong>, or <strong>Skip</strong> at any time. The timer is there to help you focus, not to interrupt you.</li>'
      + '<li>Mods and the broadcaster can also control it from chat: <code>!pomo start</code>, <code>pause</code>, <code>resume</code>, <code>skip</code>, <code>reset</code>, or <code>!pomo mode &lt;name&gt;</code>.</li>'
      + '</ul>'
      + '<h3>Looks</h3>'
      + '<p>The task boxes have their own colour, shape, font, and position settings. You can keep host and viewer tasks in one box or split them into two. The pomodoro has its own set of themes plus a custom option, and can show progress as a ring, a bar, or plain text.</p>'
      + '<h3>OBS Overlay</h3>'
      + '<p>The task list and the pomodoro are separate browser sources, so you can place them anywhere you like. Copy each URL from the preview column and add it as a Browser Source in OBS.</p>'
  },
  goals: {
    title: 'Goals',
    html: '<h3>Overview</h3>'
      + '<p>Display animated goal progress bars on stream. Supports followers, subs, bits, and custom chat commands.</p>'
      + '<h3>Creating a Goal</h3>'
      + '<ul>'
      + '<li>Click <strong>New Goal</strong>, give it a name and set a target number.</li>'
      + '<li>Choose a <strong>Source</strong>: Followers, Subscribers, Bits, or a custom <code>!command</code>.</li>'
      + '<li>Pick a colour theme, orientation (horizontal/vertical), and text placement.</li>'
      + '</ul>'
      + '<h3>Milestones</h3>'
      + '<p>Add multiple milestones to chain goals. When a target is hit the bar advances to the next one, and a single big event that clears more than one milestone advances through all of them.</p>'
      + '<h3>Celebration</h3>'
      + '<p>In the editor, pick a celebration sound and tick <strong>Channel emotes</strong> to rain your own emotes on the overlay when a goal is hit.</p>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS to show goal bars on stream.</p>'
  },
  checkins: {
    title: 'Check-ins',
    html: '<h3>Overview</h3>'
      + '<p>Show a popup on stream when a viewer redeems a channel point reward to check in. Each viewer can check in once per stream.</p>'
      + '<h3>Setting Up</h3>'
      + '<ul>'
      + '<li>Click <strong>New Config</strong> and link it to a channel point reward from the dropdown.</li>'
      + '<li>Use <code>{name}</code> for the viewer display name and <code>{count}</code> for their lifetime check-in count.</li>'
      + '<li>Adjust shape, animation, entry direction, colours, font, duration, and sound.</li>'
      + '<li>Choose from 9 screen positions for where the popup appears.</li>'
      + '<li>Use the <strong>Test</strong> button on any config (or the First Claim card) to fire a fake popup without spending channel points.</li>'
      + '</ul>'
      + '<h3>First Claim</h3>'
      + '<p>Set a separate reward for <strong>First Claim</strong>, a persistent block showing the first viewer to check in each stream. Resets when SPARK restarts.</p>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS to show check-in popups on stream.</p>'
  },
  songrequest: {
    title: 'Song Request',
    html: '<h3>Requirements</h3>'
      + '<p><strong>Pear Desktop</strong> must be installed and running. Download it at <strong>github.com/pear-devs/pear-desktop/releases</strong>.</p>'
      + '<p>In Pear Desktop, go to <strong>Settings &rarr; Plugins &rarr; API Server</strong>, enable it, and set Authorization to <strong>None</strong>.</p>'
      + '<h3>Connecting</h3>'
      + '<p>Click <strong>Connect Pear Desktop</strong>. The status dot turns green when connected.</p>'
      + '<h3>How Viewers Request Songs</h3>'
      + '<ul>'
      + '<li><strong>Channel Point Reward (recommended)</strong>: create a reward in Twitch with "Require viewer to enter text" enabled, then pick it from the dropdown. Viewers paste a YouTube link or song title as their message.</li>'
      + '<li><strong>Any Redeem</strong>: enable "Any redeem = song request" to treat any channel point redemption as a song request.</li>'
      + '<li><strong>!sr Command</strong>: enable "Allow !sr command" and choose <strong>Who can use !sr</strong>: Everyone, Followers, Subscribers, Mods only, or Broadcaster only. Mods and the broadcaster always pass regardless of the setting.</li>'
      + '</ul>'
      + '<h3>Auto Refunds and the SPARK-managed Reward</h3>'
      + '<p>Twitch has a strict rule about channel points: only the app that created a reward is allowed to touch its redemptions. A reward you made in the Twitch dashboard belongs to the dashboard, so nothing else, SPARK included, can ever give points back on it. When a redeem gets rejected on a dashboard-made reward, the points are just gone.</p>'
      + '<p>The fix is to let SPARK make the reward. Click <strong>Create reward on Twitch</strong> in the settings and SPARK creates one it owns. From then on, any rejected redeem (on cooldown, queue full, over your per-user limit, blocked song, bad link) refunds the viewer automatically, and requests that actually play get marked fulfilled so they don\'t pile up in your dashboard. Removing a song from the queue or clearing the queue refunds those viewers too.</p>'
      + '<p>Two things to know. The same ownership rule cuts the other way: the Twitch dashboard can\'t edit a reward SPARK created, so change its name and cost here in SPARK. And the first time you use this you\'ll need to log out and reconnect Twitch in Settings, because refunds need a permission the old login didn\'t ask for. If you had an old dashboard-made reward, pause or delete it in Twitch once the SPARK one exists.</p>'
      + '<h3>Queue Settings</h3>'
      + '<ul>'
      + '<li><strong>Request cooldown</strong>: minutes a viewer must wait between requests. Redeems always start the timer, and by default they have to wait it out too, so !sr and the redeem can\'t be combined to double up. With the SPARK-managed reward, a redeem that hits the cooldown is refunded.</li>'
      + '<li><strong>Max queue size</strong>: maximum songs in the queue at once.</li>'
      + '<li><strong>Per-user limit</strong>: how many songs one viewer can have queued. Set to 0 for unlimited.</li>'
      + '</ul>'
      + '<h3>Blocking Songs</h3>'
      + '<p>Some songs you just never want played. Click <strong>Block</strong> on any song in the queue and it goes on the blocked list: it leaves the queue, the viewer gets their points back, and it can never be requested again. Anyone who tries gets the message you set under Chat Responses.</p>'
      + '<p>If something is already playing, mods and the broadcaster can type <code>!srblock</code> in chat. That blocks whatever is on right now and skips straight to the next song. It works on anything playing, not only viewer requests, so it also catches tracks Pear started on its own. Viewers who try it are ignored.</p>'
      + '<p>Blocking matches on the song itself rather than just the link, so someone cannot get around it by requesting the same track from a different URL. The blocked list applies to everyone including you, and lives under <strong>Blocked Songs</strong> where you can remove anything with the ✕.</p>'
      + '<p>One limit worth knowing: a song blocked with <code>!srblock</code> while it is playing cannot be refunded. Twitch counts a request as delivered the moment it starts, and will not reverse it. Blocking from the queue, before it plays, does refund.</p>'
      + '<h3>Chat Responses</h3>'
      + '<p>Enable <strong>Send chat messages</strong> to post automatic responses. Customise each message using tokens like <code>&lt;&lt;username&gt;&gt;</code>, <code>&lt;&lt;song&gt;&gt;</code>, <code>&lt;&lt;time&gt;&gt;</code>, and more.</p>'
      + '<h3>OBS Overlays</h3>'
      + '<ul>'
      + '<li><strong>Now Playing</strong>: Browser Source at <code>http://localhost:4747/nowplaying</code>. Choose Card, Minimal, Banner, or Blend style, and set the seek bar colour to match your scene.</li>'
      + '<li><strong>Song Queue</strong>: enable "Show queue overlay" and add a Browser Source at <code>http://localhost:4747/srqueue</code>. It hides itself when empty.</li>'
      + '</ul>'
      + '<h3>Host Controls</h3>'
      + '<p>Use <strong>Manual Request</strong> to add songs yourself. Use the playback buttons in the Now Playing panel to control Pear Desktop directly from SPARK.</p>'
  },
  chat: {
    title: 'Chat',
    html: '<h3>Overview</h3>'
      + '<p>Shows live Twitch chat in-app and drives a fully customisable chat overlay: colours, shapes, glow, fonts, and animation, all set independently for Everyone, Subs, VIPs, Mods, and the Broadcaster. Follow and sub alerts appear inline in the chat feed with their own distinct styling.</p>'
      + '<h3>Style Presets</h3>'
      + '<p>Pick a built-in look, from <strong>Serious</strong> and <strong>Bland</strong> through <strong>Neon Cyberpunk</strong>, <strong>Retro Arcade</strong>, <strong>Elegant Gold</strong>, <strong>Spooky</strong>, all the way to full <strong>Cutesy</strong>. Then tweak any field. Changing any setting automatically switches to <strong>Custom</strong>.</p>'
      + '<h3>Ignore List</h3>'
      + '<p>The bot/user ignore list lives in <strong>Settings</strong> and applies everywhere. From this tab, click <strong>Ignore</strong> next to any message in the Live Chat log to add that user instantly.</p>'
      + '<h3>Role Styles</h3>'
      + '<ul>'
      + '<li>Switch between Everyone / Follower / Subscriber / VIP / Moderator / Broadcaster to style each independently.</li>'
      + '<li>Follower status is looked up automatically (and cached) the first time each viewer chats. No setup needed.</li>'
      + '<li>Set bubble shape (rounded, pill, square, speech bubble, hexagon, or text-only), background, border, glow, font, weight, and a badge icon.</li>'
      + '<li>Enable "Use viewer\'s Twitch name colour" to colour each username the way it appears in real Twitch chat instead of a fixed colour.</li>'
      + '</ul>'
      + '<h3>Follow &amp; Sub Alerts</h3>'
      + '<p>Separate styling and message template (use <code>{name}</code>) for new followers and new subscribers, including their own sound effect.</p>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS. The live preview on the right shows a looping demo of every role and alert so you can see your styling without waiting for real chat activity.</p>'
  },
  counters: {
    title: 'Counters',
    html: '<h3>Overview</h3>'
      + '<p>Create any number of chat-driven counters: death counters, hug counters, "how many times has this happened" counters, anything with a number that goes up or down.</p>'
      + '<h3>Setting Up</h3>'
      + '<ul>'
      + '<li>Click <strong>Add</strong> to create a counter, then <strong>Edit</strong> to set its increment/decrement/reset chat commands.</li>'
      + '<li><strong>Reset</strong> always requires a mod or the broadcaster, regardless of the permission setting.</li>'
      + '<li>Enable <strong>Allow a custom amount</strong> so viewers can type e.g. <code>!death 3</code> to add 3 instead of the fixed step. <strong>Max custom amount</strong> caps how much one command can add, so nobody can type a silly number.</li>'
      + '<li>Set an optional <strong>Min</strong>/<strong>Max</strong> to clamp the value.</li>'
      + '</ul>'
      + '<h3>Manual Control</h3>'
      + '<p>Use the +/− buttons, the Set field, or Reset to 0 directly in the app. Handy for correcting a miscount.</p>'
      + '<h3>Styling</h3>'
      + '<p>Pick a colour theme or go fully <strong>Custom</strong>: shape, glow, fonts, separate colours/sizes for the label and the number, a change animation (pop/bounce/shake/flash), and a text template using <code>{name}</code> and <code>{value}</code>.</p>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS. All visible counters render together, stacked or in a row.</p>'
  },
  commands: {
    title: 'Commands',
    html: '<h3>Overview</h3>'
      + '<p>Custom chat commands and rotating auto messages, so you do not need a second bot running alongside SPARK for <code>!discord</code>, <code>!socials</code> or <code>!lurk</code>.</p>'
      + '<h3>Custom Commands</h3>'
      + '<ul>'
      + '<li>Click <strong>+ New command</strong>, give it a name like <code>!discord</code>, and add one or more <strong>actions</strong>.</li>'
      + '<li>Actions run top to bottom, so one command can post a message <em>and</em> play a sound.</li>'
      + '<li>Each action can be given a <strong>name</strong>, and folded away with the arrow on its left. A long command then reads as a short list of named steps instead of a wall of settings.</li>'
      + '<li><strong>Chat message</strong> posts normally. <strong>Announcement</strong> posts the highlighted block Twitch shows for <code>/announce</code>. <strong>Play a sound</strong> plays an audio file through SPARK.</li>'
      + '<li><strong>Trigger a SPARK tool</strong> makes the command drive another tab: spin the wheel, open or draw the giveaway, start a timer, move a counter or goal bar, roll the credits, control the pomodoro. If that tool is switched off in Settings the step is skipped and the rest of the command still runs.</li>'
      + '<li><strong>Wait</strong> pauses before the next action. It only affects that one run — another command, or the same one from someone else, carries on as normal.</li>'
      + '<li><strong>Show on overlay</strong> puts text and/or an image on screen for a few seconds. Add <code>http://localhost:4747/commands</code> as a Browser Source in OBS — the URL is in the tab header. The image can come from a file, a URL, or the <strong>profile picture of whoever is @mentioned</strong>, which is what makes a shoutout command work. Placement is either a preset corner or exact X/Y coordinates in px or %. Text can reveal itself with a <strong>typewriter</strong>, word-by-word or letter-pop effect, and <strong>Padding</strong> controls how much space sits between the content and the border — set it to 0 for a border snug against the image. The "seconds on screen" hold starts after the reveal finishes, so it always means that long actually readable.</li>'
      + '<li><strong>Aliases</strong> let the same command answer to several names, e.g. <code>!dc</code> and <code>!server</code>.</li>'
      + '<li><strong>Cooldown</strong> limits the whole channel; <strong>per-viewer cooldown</strong> limits one person. You and your mods always bypass both.</li>'
      + '<li>Optionally attach a <strong>channel point reward</strong> so a redeem fires the same actions.</li>'
      + '</ul>'
      + '<h3>Getting Started Fast</h3>'
      + '<p><strong>Add starter commands</strong> at the bottom of the list opens a list of ready-made ones with a short note on each. Tick the ones you want. On offer: <code>!discord</code>, <code>!socials</code>, <code>!lurk</code>, <code>!uptime</code>, <code>!followage</code>, <code>!game</code>, <code>!followers</code>, a two-part <code>!so</code> shoutout that posts a message and puts the person\'s picture on your overlay, and <code>!raidthanks</code> which runs on its own when somebody raids you.</p>'
      + '<p>Anything whose name is already taken is greyed out with the reason, so you can see why it is not available. Everything added can be edited afterwards, and you will want to put your real links into <code>!discord</code> and <code>!socials</code>.</p>'
      + '<h3>Raids, Follows, Subs And Cheers</h3>'
      + '<p>A command does not have to be typed by anyone. Under <strong>Also run automatically when…</strong> you can set it to fire when somebody raids you, follows, subscribes, gifts subs or cheers.</p>'
      + '<p>The person who did it becomes <code>{user}</code>, and because <code>{targetavatar}</code>, <code>{targetusername}</code>, <code>{targetfollowage}</code> and <code>{targetaccountage}</code> follow them too, a raid can put the raider\'s face on your overlay with no extra work. <code>{raiders}</code> is how many people they brought; <code>{amount}</code> covers bits cheered or subs gifted.</p>'
      + '<h3>Ad Breaks</h3>'
      + '<p>The same list has three ad triggers: <strong>Ads are coming up</strong>, <strong>Ads start</strong> and <strong>Ads finish</strong>. They are separate on purpose, so you can warn chat, say something as the break begins, and welcome people back — or use only the one you want.</p>'
      + '<p><code>{adduration}</code> is how many seconds the break runs for. <code>{adnextin}</code> is how long until it starts, which only means anything on the warning.</p>'
      + '<p>Set how far ahead the warning fires in the <strong>Warn … seconds before an ad break</strong> box. There is one ad schedule, so that setting is shared by every command.</p>'
      + '<p>Two things worth knowing, both down to what Twitch does and does not tell an app. Twitch has no “an ad is coming” event, so SPARK watches your ad schedule instead — if you snooze a break after the warning has already gone out, chat has been told about an ad that is no longer coming. And nothing reports that a break has ended, so <strong>Ads finish</strong> is worked out from the start time plus the length Twitch reported. A break you cut short by hand will finish a little late.</p>'
      + '<p>These need a Twitch permission added in this release. If a warning appears at the top of the tab, go to <strong>Settings</strong>, click <strong>Log out</strong>, then connect again — a plain reconnect reuses the old permissions.</p>'
      + '<p>Nobody types anything for these, so cooldowns and permission do not apply. The starter pack includes a ready-made <code>!raidthanks</code> that thanks the raider in chat and shows their picture on stream.</p>'
      + '<h3>When A Command Is Active</h3>'
      + '<p><strong>Active</strong> can limit a command to while you are live, or while you are offline. <strong>Only in these categories</strong> limits it to certain games — comma separated, matched loosely, so "zelda" catches "The Legend of Zelda". A command that is out of season stays silent rather than replying with an excuse.</p>'
      + '<h3>Testing</h3>'
      + '<p>Pick a role, optionally type what a viewer would put after the command, and hit <strong>Run test</strong>. It runs the real permission and condition checks, so it will tell you it was blocked and why — no need to go and find an actual subscriber to try it.</p>'
      + '<h3>Adding Commands From Chat</h3>'
      + '<ul>'
      + '<li><code>!addcom !discord Join us at ...</code> creates a simple command.</li>'
      + '<li><code>!editcom !discord new text</code> changes what it says, keeping any sound or other actions.</li>'
      + '<li><code>!delcom !discord</code> removes it.</li>'
      + '<li>Mods and you only. These run the same name check as the app, so trying to claim <code>!sr</code> gets the same clear explanation in chat.</li>'
      + '</ul>'
      + '<h3>Name Clashes</h3>'
      + '<p>If you type a command that another part of SPARK already owns — <code>!sr</code>, <code>!task</code>, a counter, a goal bar — the box turns red and tells you exactly what is using it. The name will not save until you pick a free one.</p>'
      + '<h3>Variables</h3>'
      + '<p>A variable is a placeholder. You type one into a box and SPARK swaps it for the real thing when the command runs. Type <code>Thanks for the follow, {user}!</code> and chat sees <em>Thanks for the follow, DaveTheStreamer!</em></p>'
      + '<p>There are a lot of them, so the full list sits behind <strong>Variables you can use</strong> under the actions. They are grouped by what they are about, and each one shows what it turns into.</p>'
      + '<p>The ones you will use most: <code>{user}</code> for who ran the command, <code>{args}</code> for whatever they typed after it, plus <code>{uptime}</code>, <code>{game}</code>, <code>{followers}</code> and <code>{song}</code>.</p>'
      + '<p><strong>Shoutouts work on their own.</strong> A few variables follow the name the viewer typed: <code>{targetusername}</code>, <code>{targetavatar}</code>, <code>{targetfollowage}</code> and <code>{targetaccountage}</code>. So if someone types <code>!so D3stiny82</code>, <code>{targetavatar}</code> is D3stiny82\'s picture. If nobody was named, they fall back to whoever ran the command, so a plain <code>!followage</code> still shows that person\'s own.</p>'
      + '<p><strong>Watch out for this one.</strong> <code>{user}</code> is whoever <em>ran</em> the command. If your mod types <code>!so D3stiny82</code> then <code>{user}</code> is your mod, not D3stiny82. For the person being shouted out, use <code>{targetusername}</code>. The built-in <code>!so</code> already does this correctly, so it is a safe thing to copy.</p>'
      + '<p>Use <code>{targetusername}</code> rather than <code>{arg1}</code> for this. <code>{arg1}</code> gives you exactly what was typed, so <code>!so @D3stiny82</code> would put the @ into your link and break it. <code>{targetusername}</code> asks Twitch for the real name, and it also still works on a raid, where nobody typed anything at all.</p>'
      + '<p>The preview under each box always shows what chat will get, so you never have to guess.</p>'
      + '<h3>Auto Messages</h3>'
      + '<ul>'
      + '<li>Rotating messages SPARK posts on its own — the classic "follow me on…" plug.</li>'
      + '<li>Set how often it posts, and optionally require a minimum number of chat lines since the last one so it stays quiet in a dead chat.</li>'
      + '<li>By default nothing posts while you are offline.</li>'
      + '</ul>'
      + '<h3>Announcements Permission</h3>'
      + '<p>Announcements need a Twitch permission added in this release. If you connected before it, a warning appears at the top of this tab. Go to <strong>Settings</strong>, click <strong>Log out</strong>, then connect again — a plain reconnect reuses the old permissions, so the full log out is the part that matters. Chat messages and sounds work either way.</p>'
      + '<h3>Italics</h3>'
      + '<p>There is no <code>/me</code> option: Twitch\'s message API drops anything starting with a slash. Use an announcement when you want a message to stand out.</p>'
  },
  credits: {
    title: 'Credits',
    html: '<h3>Overview</h3>'
      + '<p>End-of-stream rolling credits, like a movie. Only viewers who actually chatted are included, grouped into Moderators, VIPs, Subscribers, Followers, Viewers, and a free-text Special Thanks section.</p>'
      + '<h3>Sections</h3>'
      + '<ul>'
      + '<li>Toggle any section on/off, rename its heading, and reorder sections in <strong>Section Order</strong>.</li>'
      + '<li>If a chatter qualifies for more than one section (e.g. Mod + Sub), <strong>Role Priority</strong> decides which one they show up in.</li>'
      + '<li>Use <strong>Manually add names</strong> on any section to include someone who didn\'t chat, and the <strong>Exclude List</strong> to filter out bots or anyone else.</li>'
      + '<li><strong>Special Thanks</strong> is free text, not tied to chat at all.</li>'
      + '</ul>'
      + '<h3>Styling</h3>'
      + '<p>Pick a style preset then customise colours, fonts, and sizes per section, plus scroll direction/speed, background, avatars, and an optional music bed. Save your own presets and update them anytime.</p>'
      + '<h3>Session</h3>'
      + '<p>The chatter list resets automatically the first time SPARK connects to Twitch after launch, or manually via <strong>Reset Session</strong>. Use <strong>Preview (sample names)</strong> to test styling before your chatter list has built up.</p>'
      + '<h3>OBS Overlay</h3>'
      + '<p>Copy the <strong>Overlay URL</strong> and add it as a Browser Source in OBS, then click <strong>Play Credits</strong> when you\'re ready to run them (e.g. at the end of stream).</p>'
  },
  diy: {
    title: 'D.I.Y Widgets',
    html: '<h3>Overview</h3>'
      + '<p>Build your own chat and alert overlays right here. Add a widget, style it with the visual Designer or with your own CSS, then copy its link into OBS. Everything runs on your live Twitch chat and events inside SPARK.</p>'
      + '<h3>Adding a widget</h3>'
      + '<p>Click <strong>Chat widget</strong> or <strong>Alert widget</strong>. Each one you add gets its own overlay URL. Use <strong>Edit</strong> to open it, <strong>Duplicate</strong> to copy one and try a variation, and the preview on the right runs demo traffic so you can style without waiting for real activity.</p>'
      + '<h3>Designer or Custom CSS</h3>'
      + '<p>Every widget has two modes and you can switch any time. What you set in one mode does not change the other.</p>'
      + '<ul>'
      + '<li><strong>Designer</strong> gives you colour pickers and sliders for background, opacity, text colour, accent colour, corners, padding, font size, glow, drop shadow, plus entrance and exit animations with a speed.</li>'
      + '<li><strong>Custom CSS</strong> lets you write your own styles. Each widget lists the class names you can target. For chat you can style each chatter level on its own with <code>.msg.role-sub</code>, <code>.msg.role-vip</code>, <code>.msg.role-mod</code>, and the rest.</li>'
      + '<li><strong>Copy my design as CSS</strong> turns your current Designer look into editable CSS and switches you to Custom CSS.</li>'
      + '</ul>'
      + '<h3>Chat options</h3>'
      + '<ul>'
      + '<li><strong>Scroll direction</strong> sets which way chat moves and where new messages appear.</li>'
      + '<li><strong>Name styling</strong> lets you give each role an icon (an emoji or an image), a custom colour, and a glow. Tick <strong>CC</strong> to turn the custom colour on for that role. Leave CC off and that viewer keeps their normal Twitch colour.</li>'
      + '<li><strong>Show events in chat</strong> puts follows, subs, and raids into the chat as highlighted lines. You can word each one and style the highlight.</li>'
      + '<li><strong>Tilt</strong> leans messages for a scattered look, with an option to alternate the angle.</li>'
      + '<li><strong>Gradient background</strong> fades the sides of each message.</li>'
      + '<li><strong>Gap</strong>, <strong>Max messages kept</strong>, and <strong>Hide after</strong> set the spacing, how many messages stay on screen, and whether old ones fade out on a timer. Chat scrolls off the top and old messages are removed so it never fills memory.</li>'
      + '<li><strong>Single-line messages</strong> cuts long messages off with ... instead of wrapping, and <strong>Max message width</strong> sets where that happens.</li>'
      + '<li>Anyone in your Settings ignore list never shows, so bots stay out.</li>'
      + '</ul>'
      + '<h3>Alert options</h3>'
      + '<ul>'
      + '<li><strong>Show these alerts</strong> picks which of Follow, Sub, Bits, and Raid this box shows. Make separate boxes for different events if you want.</li>'
      + '<li><strong>Alert text</strong> lets you write the Title and Message for each event. Use {name} and {amount} and they fill in automatically.</li>'
      + '<li><strong>On screen</strong> sets how many seconds an alert stays before it leaves.</li>'
      + '<li><strong>Sound</strong> plays a file you pick the moment the alert fires. Any length works.</li>'
      + '</ul>'
      + '<h3>Testing and OBS</h3>'
      + '<p>Use the <strong>Test</strong> buttons to fire a message or alert on the preview and on your live overlay. When you like it, copy the widget <strong>URL</strong> and add it as a Browser Source in OBS.</p>'
  },
  broadcast: {
    title: 'Broadcast',
    html: '<h3>Overview</h3>'
      + '<p>The things you would otherwise open twitch.tv for while you are live: your title and category, chat with moderation, and quick actions.</p>'
      + '<h3>Stream Info</h3>'
      + '<ul>'
      + '<li>Edit your <strong>title</strong>, <strong>category</strong> and <strong>tags</strong>, then click <strong>Apply to Twitch</strong>. Nothing is sent until you do.</li>'
      + '<li>The category box searches Twitch as you type — pick from the results rather than typing the name exactly.</li>'
      + '<li>Tags cannot contain spaces, so any you type are removed. Twitch allows 10 tags of 25 characters each.</li>'
      + '<li>A dot on the Apply button means you have unsaved changes. <strong>Revert</strong> puts everything back to what Twitch currently has.</li>'
      + '</ul>'
      + '<h3>Presets</h3>'
      + '<p>A preset stores the title, category and tags <em>together</em>. Set the three fields how you want them, name it and click <strong>Save current</strong>. Loading it later fills all three in at once — handy when you switch games mid-stream.</p>'
      + '<p>Loading a preset does not send anything to Twitch. You still press <strong>Apply</strong>, so you get a chance to tweak the title first.</p>'
      + '<p>Saving under a name you have already used replaces that preset instead of adding a second one.</p>'
      + '<h3>Stream Marker</h3>'
      + '<p>Drops a bookmark at the current moment so you can jump straight to it when editing the VOD later. Only works while you are live.</p>'
      + '<h3>Status</h3>'
      + '<p>Shows whether you are live, how long for, your viewer count, and when your next ad break is due. The ad readout is information only — every ad trigger lives in the <strong>Commands</strong> tab.</p>'
      + '<h3>Chat</h3>'
      + '<ul>'
      + '<li>Hover a message for <strong>Delete</strong>, a 10-minute timeout, <strong>Ban</strong> and <strong>Pin</strong>.</li>'
      + '<li>Those buttons are hidden on your own messages and your mods\' — Twitch refuses to delete or time out either.</li>'
      + '<li>Timing someone out strikes through their other messages too, matching what Twitch does on its side.</li>'
      + '<li>Click a <strong>name</strong> for mod, VIP, whisper and timeout.</li>'
      + '<li>Chat only scrolls itself when you are already at the bottom, so reading back is never yanked away.</li>'
      + '<li><strong>Clear view</strong> empties this list only. Nothing is deleted on Twitch.</li>'
      + '</ul>'
      + '<h3>Raid and Shoutout</h3>'
      + '<p>Type a channel name and pick one. Raiding starts Twitch\'s 90-second countdown rather than moving people immediately, and a link to cancel it appears underneath.</p>'
      + '<p>Twitch limits shoutouts to one every 2 minutes, and one per channel per hour. Both of you have to be live.</p>'
      + '<h3>Polls and Predictions</h3>'
      + '<ul>'
      + '<li>Only one of each can run at a time — that is Twitch\'s rule, not SPARK\'s.</li>'
      + '<li>While one is running you get live results in place of the form.</li>'
      + '<li><strong>Templates</strong> save the question, the answers and the timer together, so a poll you run every stream is one click instead of retyping it.</li>'
      + '<li>Predictions can be <strong>locked</strong> (no more entries, not yet paid out) before you pick a winner. <strong>Refund everyone</strong> cancels and returns the points.</li>'
      + '</ul>'
      + '<h3>Chat Mode and Ads</h3>'
      + '<ul>'
      + '<li><strong>Emote only</strong>, <strong>Subs only</strong> and <strong>Followers only</strong> are toggles — gold means on. They show their current state when you open the tab, including changes you made from Twitch itself.</li>'
      + '<li><strong>Followers-only</strong> can require a <em>minimum follow age</em> — how long someone must already have been following before they may chat. "Any follower" lets a brand-new follower talk straight away; "10 minutes" makes them wait. Follow-and-spam bots follow and post immediately, so even a short wait stops most of them. Changing it while the mode is on applies right away.</li>'
      + '<li><strong>Clear chat history</strong> wipes chat for everyone watching and cannot be undone, so it asks first.</li>'
      + '<li>Ad lengths run from 30 seconds to 3 minutes. Ads need you to be live and an affiliate or partner, and Twitch enforces a cooldown between breaks — the message tells you when the next one is allowed.</li>'
      + '<li><strong>Snooze</strong> pushes your next automatic ad back 5 minutes. You get a limited number per stream.</li>'
      + '</ul>'
      + '<h3>Layout</h3>'
      + '<p>Drag the bar between chat and the actions below it to resize them. Each action section collapses by clicking its heading — a shut section still shows a tag when something is running, such as a poll or emote-only chat. SPARK remembers both.</p>'
  },
  settings: {
    title: 'Settings',
    html: '<h3>Theme</h3>'
      + '<p>Six looks for SPARK itself: Midnight Purple, Deep Ocean, Charcoal, Forest, Ember and Light. Click one and it applies straight away.</p>'
      + '<ul>'
      + '<li>Your overlays are not touched. What goes out on stream stays exactly as you designed it, because those are your colours rather than SPARK\'s.</li>'
      + '<li>The theme is saved with the profile you are on, so a co-working setup could be charcoal while your everything setup stays purple.</li>'
      + '<li>Light keeps the gold buttons but darkens gold text, since bright gold on white cannot be read.</li>'
      + '</ul>'
      + '<h3>Profiles</h3>'
      + '<p>A profile is a whole SPARK setup saved under a name. Keep one for a quiet stream with almost nothing running, one for co-working, one with everything switched on, and swap between them instead of rebuilding your setup each time.</p>'
      + '<ul>'
      + '<li>The profile you are on is the one you are editing. Every change you make anywhere in SPARK saves into it as you go, so there is no separate save step and nothing to forget.</li>'
      + '<li><strong>Add copy of current</strong> makes a new profile that starts out identical to how SPARK is set up right now. This is usually what you want, since you can then trim it down.</li>'
      + '<li><strong>Add empty</strong> starts a profile at the defaults, as though SPARK were freshly installed.</li>'
      + '<li><strong>Switch to</strong> loads that profile. <strong>Duplicate</strong> copies one so you can make a variation. <strong>Rename</strong> and <strong>✕</strong> do what they say.</li>'
      + '<li>You cannot delete the profile you are on, or the last one left.</li>'
      + '</ul>'
      + '<h3>What a profile remembers</h3>'
      + '<p>Nearly everything: your wheel lists, giveaway setup, timers and auto timers, tasks, goals, check-in configs, song request settings, chat and credits styling, counters, D.I.Y widgets, which tools are switched on under Tool Availability, and which tools appear on the master overlay.</p>'
      + '<h3>What every profile shares</h3>'
      + '<p>Some things follow you rather than the setup, so switching never disturbs them:</p>'
      + '<ul>'
      + '<li>Your Twitch connection, so a switch never signs you out.</li>'
      + '<li>Your YouTube Music connection for song requests.</li>'
      + '<li>Check-in counts, so a regular\'s total never appears to jump around.</li>'
      + '<li>The credits chatter history for the stream you are on.</li>'
      + '<li>The bot and user ignore list.</li>'
      + '</ul>'
      + '<h3>Switching</h3>'
      + '<p>Switching restarts the SPARK window, which takes a second or two. Your overlays in OBS reconnect on their own, though they will blink as they do. Timers and pomodoro sessions come back the same way they would after any restart, following their auto-resume settings.</p>'
      + '<p>Nothing is lost when you switch. The setup you are leaving is saved into its own profile before the new one loads.</p>'
      + '<h3>Tool Availability</h3>'
      + '<p>Turn a tool off and it stops answering chat commands and channel point redeems. Viewers who try get the message you set next to it. Changes save the moment you tick a box.</p>'
      + '<p>Redeems still spend the viewer\'s points even when the tool is off, so disable the reward in your Twitch dashboard too if you want it fully stopped.</p>'
      + '<h3>Backup and Restore</h3>'
      + '<p>Export writes a file holding your lists, goals, check-in counts and settings, including every profile. Twitch tokens are left out, so on a new machine you reconnect once and everything else is already there.</p>'
  }
};

function initHelpSystem() {
  var modal = document.getElementById('helpModal');
  var body  = document.getElementById('helpBoxBody');
  var title = document.getElementById('helpBoxTabName');
  document.getElementById('helpBoxClose').addEventListener('click', function() {
    modal.classList.remove('open');
  });
  modal.addEventListener('click', function(e) {
    if (e.target === modal) modal.classList.remove('open');
  });
  window.showHelp = function(tabId) {
    var cfg = HELP_CONTENT[tabId];
    if (!cfg) return;
    title.textContent = cfg.title;
    body.innerHTML = cfg.html;
    modal.classList.add('open');
  };
}

// ── Update check (GitHub releases) ────────────────────────────────────────────
// Owner/repo the release check queries. Must match the current GitHub owner:
// a renamed account only redirects until someone else claims the old username.
const UPDATE_REPO = 'TheITStreamer/S.P.A.R.K';

function cmpVer(a, b){ // 1 if a > b, -1 if a < b, 0 if equal
  const pa = a.split('.').map(n=>parseInt(n)||0), pb = b.split('.').map(n=>parseInt(n)||0);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    if((pa[i]||0) > (pb[i]||0)) return 1;
    if((pa[i]||0) < (pb[i]||0)) return -1;
  }
  return 0;
}

async function checkForUpdate(){
  try{
    const current = await invoke('get_app_version');
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      { headers:{ 'Accept':'application/vnd.github+json' } });
    if(!r.ok) return; // no releases yet, offline, rate-limited — all fine, stay quiet
    const rel = await r.json();
    const m = String(rel.tag_name||'').match(/\d+(\.\d+)*/);
    if(!m) return;
    const latest = m[0];
    if(cmpVer(latest, current) <= 0) return;
    // Prefer a direct installer link if one is attached to the release
    const asset = (rel.assets||[]).find(a=>/\.(msi|exe)$/i.test(a.name||''));
    const url = asset ? asset.browser_download_url
                      : (rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`);
    showUpdateBanner(latest, url);
  }catch(e){ /* never let the update check bother the user */ }
}

function showUpdateBanner(version, url){
  if(document.getElementById('updateBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'updateBanner';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;gap:12px;justify-content:center;padding:8px 14px;background:var(--ok-bg);color:var(--ok-ink);font-size:.88rem;font-weight:600;box-shadow:0 2px 12px rgba(0,0,0,.5)';
  bar.innerHTML = `<span>SPARK v${version} is available!</span>`
    + '<button id="updGet" style="cursor:pointer;border:none;border-radius:6px;padding:4px 12px;font-weight:700;background:var(--ok-ink);color:#143914">Download</button>'
    + '<button id="updX" style="cursor:pointer;border:none;background:none;color:var(--ok-ink);font-size:1.1rem;padding:0 4px">✕</button>';
  document.body.appendChild(bar);
  bar.querySelector('#updGet').addEventListener('click', ()=>{
    try{ if(window.__TAURI__.opener) window.__TAURI__.opener.openUrl(url); else window.open(url,'_blank'); }
    catch(_){ window.open(url,'_blank'); }
  });
  bar.querySelector('#updX').addEventListener('click', ()=>bar.remove());
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot(){
  const data = await invoke('load_all_data');
  store.wheel       = data.wheel       || {};
  store.giveaway    = data.giveaway    || {};
  store.timers      = data.timers      || { list:[] };
  store.tasks       = data.tasks       || { list:[], settings:{} };
  store.goals       = data.goals       || { bars:[] };
  store.checkins    = data.checkins    || { configs:[], firstClaim:{} };
  store.songrequest = data.songrequest || { cfg:{}, queue:[] };
  store.chat        = data.chat        || {};
  store.counters    = data.counters    || {};
  store.credits     = data.credits     || {};
  store.diy         = data.diy         || { widgets: [] };
  store.commands    = data.commands    || { commands:[], automessages:[], cfg:{} };
  store.broadcast   = data.broadcast   || {};
  store.settings    = data.settings    || {};
  store.twitch_tokens = data.twitch_tokens || {};

  // Settings is the source of truth for the theme. The <head> script has
  // already applied a cached copy to avoid a flash; this corrects it if the
  // two ever disagree, which happens the first time a profile with a different
  // theme is loaded.
  applyTheme(store.settings.theme);

  // One-time migration: Chat's per-tab bot ignore list → global Settings list.
  // Idempotent (dedupes), so a failed save just retries next boot.
  if(!Array.isArray(store.settings.ignoreList)) store.settings.ignoreList = [];
  const legacyIgn = Array.isArray(store.chat.ignoreList) ? store.chat.ignoreList : [];
  if(legacyIgn.length){
    legacyIgn.forEach(u=>{
      const v = String(u||'').trim().toLowerCase();
      if(v && !store.settings.ignoreList.includes(v)) store.settings.ignoreList.push(v);
    });
    store.chat.ignoreList = []; // chat tab persists the cleared list on its next save
    invoke('save_app_settings', { data: store.settings });
  }

  const urls = await invoke('overlay_url');
  store.overlayUrls = urls;

  // Fonts before any tab renders: built-in families load once for the whole app
  // instead of each tab requesting its own overlapping Google stylesheet, and
  // imported fonts come from the overlay server, whose URL was just read above.
  await initFonts();

  // Follower cache lives in Rust; Chat and Credits need a synchronous answer
  // per message, so they read an in-memory mirror of it. Fetch it once, before
  // either tab can receive a message.
  await loadFollowerMirror();

  // init help system before tabs so modal is ready
  initHelpSystem();

  // init each tab
  await initSettings();
  // initTabChrome() runs before the data file is read, so it sees empty tool
  // toggles AND no saved sidebar layout. Apply both now that settings are in.
  applySavedTabLayout();
  refreshDisabledBanner();
  await initWheel();
  await initGiveaway();
  await initTimers();
  await initTasks();
  await initGoals();
  await initCheckins();
  initSongRequest();
  await initChat();
  await initCounters();
  await initCredits();
  await initDiy();
  // Last of the tabs: its chat handler should see a fully-populated store when
  // it checks for command collisions against Counters, Goals and the rest.
  await initCommands();
  await initBroadcast();

  // Scope check runs after every tab exists — "Reconnect now" jumps to Settings,
  // which has to be built by then. It waits on the connection status event, so
  // nothing here blocks on Twitch being reachable.
  initReauth();

  // global Twitch event forwarding
  await listen('twitch-status', ev=>{
    const d = ev.payload;
    if(d.connected) setHeaderStatus('on','Connected');
    else setHeaderStatus('err', d.error||'Disconnected');
    window.dispatchEvent(new CustomEvent('spark-twitch-status', {detail: d}));
  });
  // Dedupe redeems by redemption id — Twitch can redeliver an EventSub
  // notification. Keeps the last 200 ids.
  const seenRedemptions = new Set();
  await listen('twitch-redeem', ev=>{
    const rid = ev.payload && ev.payload.redemption_id;
    if (rid) {
      if (seenRedemptions.has(rid)) { console.warn('[redeem] duplicate dropped:', rid); return; }
      seenRedemptions.add(rid);
      if (seenRedemptions.size > 200) { const first = seenRedemptions.values().next().value; seenRedemptions.delete(first); }
    }
    window.dispatchEvent(new CustomEvent('spark-redeem', {detail: ev.payload}));
  });
  await listen('twitch-chat', ev=>{
    window.dispatchEvent(new CustomEvent('spark-chat', {detail: ev.payload}));
  });
  await listen('twitch-goal', ev=>{
    window.dispatchEvent(new CustomEvent('spark-goal', {detail: ev.payload}));
  });
  // Ad break started. Only the start is a real Twitch event; the Commands tab
  // derives the warning and the finish from this plus the ad schedule.
  await listen('twitch-ad', ev=>{
    window.dispatchEvent(new CustomEvent('spark-ad', {detail: ev.payload}));
  });
  // Stream went live or ended (EventSub). Two things come out of this:
  //
  //   spark-stream       — every event, for anything that just needs to know
  //                        whether you are live right now.
  //   spark-stream-start — only when a GENUINELY new stream begins.
  //
  // The split exists because a dropped connection looks exactly like the end of
  // one stream and the start of another. Coming back within the grace window is
  // treated as the same stream, so a blip mid-broadcast cannot let everyone
  // check in twice or wipe the first claim.
  const STREAM_RESUME_GRACE_MS = 5 * 60 * 1000;
  await listen('twitch-stream', ev=>{
    const d = ev.payload || {};
    const now = Date.now();

    if(!d.live){
      // Remembered across restarts so a crash during the gap does not turn a
      // resume into a fresh stream. One write per stream end — negligible.
      store.settings.lastStreamOfflineAt = now;
      invoke('save_app_settings', { data: store.settings }).catch(()=>{});
      window.dispatchEvent(new CustomEvent('spark-stream', {detail:{live:false}}));
      return;
    }

    const lastOff = store.settings.lastStreamOfflineAt || 0;
    const resumed = lastOff > 0 && (now - lastOff) < STREAM_RESUME_GRACE_MS;
    window.dispatchEvent(new CustomEvent('spark-stream', {detail:{live:true, resumed, startedAt:d.started_at}}));
    if(!resumed){
      window.dispatchEvent(new CustomEvent('spark-stream-start', {detail:{startedAt:d.started_at}}));
    }
    // Either way this stream is running now; clear the marker so a later
    // genuine start is not measured against a stale timestamp.
    if(store.settings.lastStreamOfflineAt){
      store.settings.lastStreamOfflineAt = 0;
      invoke('save_app_settings', { data: store.settings }).catch(()=>{});
    }
  });
  // Chat sends are queued in Rust, so a failure arrives as this event rather
  // than as a rejected invoke().
  await listen('spark-send-error', ev=>{
    window.dispatchEvent(new CustomEvent('spark-send-error', {detail: ev.payload}));
  });
  // Someone tried to launch a second copy of SPARK — it was blocked (a second
  // instance would take a different port and break every overlay URL).
  await listen('spark-second-instance', ()=>{
    alert('SPARK is already running. This is the running copy.\n\nA second SPARK was blocked because it would take a different port and your OBS overlays would stop updating.');
  });

  // fire-and-forget — never blocks or breaks boot
  checkForUpdate();
}

boot().catch(err => {
  console.error('SPARK boot failed:', err);
  document.body.innerHTML = '<div style="padding:40px;color:#ff5d73;font-family:monospace;background:var(--bg);min-height:100vh">'
    + '<h2 style="color:#ffc83d;margin-bottom:16px">SPARK failed to start</h2>'
    + '<pre style="white-space:pre-wrap;font-size:.85rem">' + (err && err.stack ? err.stack : String(err)) + '</pre>'
    + '<p style="margin-top:20px;color:var(--muted)">Please share this error message.</p>'
    + '</div>';
});
