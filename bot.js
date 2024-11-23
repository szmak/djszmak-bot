require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    ButtonBuilder,
    ActionRowBuilder,
    ButtonStyle,
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
} = require('@discordjs/voice');
const axios = require('axios');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // Ensure this is defined in your .env
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
    ],
});

let currentConnection = null;
let currentPlayer = createAudioPlayer();
let queue = [];
let isPlaying = false;
let progressInterval = null;

// Register Slash Commands
const commands = [
    {
        name: 'play',
        description: 'Play a song from YouTube or Spotify',
        options: [
            {
                name: 'url',
                type: 3, // STRING type
                description: 'The YouTube or Spotify URL',
                required: true,
            },
        ],
    },
    { name: 'queue', description: 'Show the current song queue' },
    { name: 'leave', description: 'Make the bot leave the voice channel' },
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Successfully registered slash commands.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
})();

client.on('ready', () => {
    console.log(`djszmakBOT is ready!`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    if (interaction.isCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'play') {
            const url = options.getString('url');
            const channel = interaction.member.voice.channel;

            if (!channel) {
                return interaction.reply('You need to join a voice channel first!');
            }

            try {
                await interaction.deferReply();

                let songInfo;
                if (url.includes('spotify.com')) {
                    const trackInfo = await fetchSpotifyTrackInfo(url);
                    songInfo = await searchYouTube(`${trackInfo.artist} - ${trackInfo.title} HQ audio`);
                } else {
                    songInfo = await fetchYouTubeSongInfo(url);
                }

                queue.push(songInfo);
                await interaction.editReply(`🎵 Added to queue: **${songInfo.title}**`);

                if (!isPlaying) {
                    playNextSong(interaction, false);
                }
            } catch (error) {
                console.error('Error fetching song info:', error);
                await interaction.editReply('❌ Failed to fetch song info. Please try again.');
            }
        }

        if (commandName === 'queue') {
            const queueList = queue.length
                ? queue.map((song, index) => `${index + 1}. ${song.title}`).join('\n')
                : 'Queue is empty.';
            await interaction.reply(`🎶 Current Queue:\n${queueList}`);
        }

        if (commandName === 'leave') {
            if (currentConnection) {
                currentConnection.destroy();
                currentConnection = null;
                queue = [];
                isPlaying = false;
                if (progressInterval) clearInterval(progressInterval);
                await interaction.reply('👋 Left the voice channel and cleared the queue.');
            } else {
                await interaction.reply('I am not in a voice channel.');
            }
        }
    }

    if (interaction.isButton()) {
        const { customId } = interaction;

        switch (customId) {
            case 'pause':
                if (currentPlayer.state.status === AudioPlayerStatus.Playing) {
                    currentPlayer.pause();
                    await interaction.reply({ content: '⏸️ Paused the music.', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'Music is already paused.', ephemeral: true });
                }
                break;
            case 'resume':
                if (currentPlayer.state.status === AudioPlayerStatus.Paused) {
                    currentPlayer.unpause();
                    await interaction.reply({ content: '▶️ Resumed the music.', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'Music is not paused.', ephemeral: true });
                }
                break;
            case 'stop':
                currentPlayer.stop();
                queue = [];
                isPlaying = false;
                if (progressInterval) clearInterval(progressInterval);
                await interaction.reply({ content: '⏹️ Stopped the music and cleared the queue.', ephemeral: true });
                break;
            case 'skip':
                if (queue.length > 0) {
                    if (progressInterval) clearInterval(progressInterval);
                    currentPlayer.stop(); // Stop the current song cleanly
                    await interaction.deferReply({ ephemeral: true });
                    playNextSong(interaction, true); // Play the next song
                    await interaction.editReply({ content: '⏭️ Skipped to the next song.' });
                } else {
                    await interaction.reply({ content: 'No more songs in the queue.', ephemeral: true });
                }
                break;
        }
    }
});

async function playNextSong(interaction, fromSkip) {
    if (queue.length === 0) {
        isPlaying = false;

        if (progressInterval) clearInterval(progressInterval);

        if (fromSkip) {
            try {
                await interaction.editReply({ content: 'The queue is empty. Stopping playback.' });
            } catch (error) {
                console.error('Failed to edit reply for empty queue:', error.message);
            }
        }
        return;
    }

    isPlaying = true;
    const { url, title, duration } = queue.shift();

    // Ensure the bot is still in the channel
    if (!currentConnection) {
        currentConnection = joinVoiceChannel({
            channelId: interaction.member.voice.channel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });
    }

    // Fetch the song resource and play it
    const ytdlpProcess = spawn('yt-dlp', [url, '-f', 'bestaudio', '-o', '-']);
    const audioStream = Readable.from(ytdlpProcess.stdout);

    const resource = createAudioResource(audioStream, { metadata: { title } });
    currentPlayer.play(resource);

    currentConnection.subscribe(currentPlayer);

    // Reset progress tracking
    let elapsedTime = 0;
    if (progressInterval) clearInterval(progressInterval);

    let progressMessage;
    try {
        if (fromSkip) {
            progressMessage = await interaction.editReply({
                content: `🎶 Now Playing: **${title}**\n` + generateProgressBar(elapsedTime, duration),
                components: [generateControls()],
            });
        } else {
            progressMessage = await interaction.followUp({
                content: `🎶 Now Playing: **${title}**\n` + generateProgressBar(elapsedTime, duration),
                components: [generateControls()],
            });
        }
    } catch (error) {
        console.error('Failed to send progress message:', error.message);
    }

    // Update the progress bar in real-time
    progressInterval = setInterval(async () => {
        elapsedTime++;
        if (elapsedTime >= duration) {
            clearInterval(progressInterval);
        }
        if (progressMessage) {
            try {
                await progressMessage.edit({
                    content: `🎶 Now Playing: **${title}**\n` + generateProgressBar(elapsedTime, duration),
                    components: [generateControls()],
                });
            } catch (error) {
                console.error('Failed to update progress message:', error.message);
            }
        }
    }, 1000);

    // Handle the next song when the current one ends
    currentPlayer.once(AudioPlayerStatus.Idle, () => {
        clearInterval(progressInterval);
        playNextSong(interaction, false);
    });
}

async function fetchYouTubeSongInfo(url) {
    const process = spawn('yt-dlp', ['--print', '%(title)s\n%(duration)s', '--', url]);

    let output = '';
    return new Promise((resolve, reject) => {
        process.stdout.on('data', (data) => (output += data.toString()));
        process.on('close', (code) => {
            if (code === 0) {
                const [title, durationStr] = output.trim().split('\n');
                const duration = parseInt(durationStr, 10);
                resolve({ url, title, duration });
            } else {
                reject(new Error('Failed to fetch YouTube song info.'));
            }
        });
    });
}

async function searchYouTube(query) {
    const process = spawn('yt-dlp', [
        `ytsearch1:${query}`,
        '--print',
        '%(webpage_url)s\n%(title)s\n%(duration)s',
    ]);
    let output = '';
    return new Promise((resolve, reject) => {
        process.stdout.on('data', (data) => (output += data.toString()));
        process.on('close', (code) => {
            if (code === 0) {
                const [url, title, durationStr] = output.trim().split('\n');
                const duration = parseInt(durationStr, 10);
                resolve({ url, title, duration });
            } else {
                reject(new Error('YouTube search failed.'));
            }
        });
    });
}

function generateControls() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setLabel('⏸️ Pause').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('resume').setLabel('▶️ Resume').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('stop').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Secondary)
    );
}

function generateProgressBar(currentTime, totalTime) {
    const barLength = 20;
    const progress = Math.floor((currentTime / totalTime) * barLength);
    const bar = `[${'#'.repeat(progress)}${'-'.repeat(barLength - progress)}]`;
    return `${bar} ${formatTime(currentTime)} / ${formatTime(totalTime)}`;
}

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

async function fetchSpotifyTrackInfo(url) {
    const spotifyToken = await getSpotifyAccessToken();
    const trackId = url.split('/track/')[1].split('?')[0];
    const response = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${spotifyToken}` },
    });
    const { name, artists } = response.data;
    return { title: name, artist: artists[0].name };
}

async function getSpotifyAccessToken() {
    const response = await axios.post('https://accounts.spotify.com/api/token', null, {
        params: {
            grant_type: 'client_credentials',
            client_id: SPOTIFY_CLIENT_ID,
            client_secret: SPOTIFY_CLIENT_SECRET,
        },
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });
    return response.data.access_token;
}

client.login(BOT_TOKEN);