require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const axios = require('axios');
const express = require('express');
const cors = require('cors');

// Discord Configuration
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Spotify Configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Discord Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
    ],
});

// Helper: Get Spotify Access Token
async function getSpotifyAccessToken(clientId, clientSecret) {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    const headers = {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
    };

    try {
        const response = await axios.post(tokenUrl, params, { headers });
        return response.data.access_token;
    } catch (error) {
        console.error('Error fetching Spotify access token:', error.response?.data || error.message);
        return null;
    }
}

// Helper: Get Spotify Track Info
async function getSpotifyTrackInfo(spotifyUrl) {
    const trackId = spotifyUrl.split('/').pop().split('?')[0]; // Extract track ID
    const token = await getSpotifyAccessToken(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET);
    if (!token) {
        throw new Error('Failed to get Spotify access token.');
    }

    const apiUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
    const headers = { Authorization: `Bearer ${token}` };

    try {
        const response = await axios.get(apiUrl, { headers });
        const { name: title, artists } = response.data;
        const artistName = artists[0].name;
        return `${artistName} - ${title}`; // Construct YouTube search query
    } catch (error) {
        console.error('Error fetching track info:', error.response?.data || error.message);
        return null;
    }
}

// Register Slash Commands
const commands = [
    {
        name: 'play',
        description: 'Play a song from a YouTube or Spotify URL',
        options: [
            {
                name: 'url',
                type: 3,
                description: 'The YouTube or Spotify URL',
                required: true,
            },
        ],
    },
    { name: 'stop', description: 'Stop the currently playing music' },
    { name: 'leave', description: 'Make the bot leave the voice channel' },
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
            body: commands,
        });
        console.log('Successfully registered slash commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
})();

let currentConnection = null;
let currentPlayer = null;

client.once('ready', () => {
    console.log('djszmakBOT is ready!');
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'play') {
        const url = options.getString('url');
        if (!url) {
            return interaction.reply('Please provide a valid Spotify or YouTube URL!');
        }

        const channel = interaction.member.voice.channel;
        if (!channel) {
            return interaction.reply('You need to join a voice channel first!');
        }

        try {
            await interaction.deferReply();

            let searchQuery = '';

            if (url.includes('spotify.com')) {
                searchQuery = await getSpotifyTrackInfo(url);
                if (!searchQuery) {
                    return interaction.editReply('Failed to fetch track info. Please try again.');
                }
            } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
                searchQuery = url; // Use YouTube URL directly
            } else {
                return interaction.editReply('Invalid URL. Please provide a Spotify or YouTube URL.');
            }

            console.log(`Searching YouTube for: ${searchQuery}`);

            const ytdlpSearch = spawn('yt-dlp', [`ytsearch1:${searchQuery}`, '--format', 'bestaudio', '-j']);

            let youtubeData = '';

            ytdlpSearch.stdout.on('data', (chunk) => {
                youtubeData += chunk.toString();
            });

            ytdlpSearch.on('close', async (code) => {
                if (code !== 0 || !youtubeData.trim()) {
                    console.error('No search results found.');
                    return interaction.editReply('No results found for the given song.');
                }

                const videoDetails = JSON.parse(youtubeData);
                const videoUrl = videoDetails.webpage_url;

                if (currentConnection) {
                    currentConnection.destroy();
                }

                currentConnection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                });

                const ytdlpStream = spawn('yt-dlp', [videoUrl, '-f', 'bestaudio', '-o', '-']);
                const audioStream = new Readable().wrap(ytdlpStream.stdout);

                const resource = createAudioResource(audioStream);
                currentPlayer = createAudioPlayer();
                currentConnection.subscribe(currentPlayer);
                currentPlayer.play(resource);

                currentPlayer.on(AudioPlayerStatus.Playing, () => {
                    interaction.editReply(`🎵 Now playing: ${searchQuery}`);
                });

                currentPlayer.on('error', (error) => {
                    console.error('Audio player error:', error);
                    interaction.editReply('There was an error playing the song.');
                });
            });
        } catch (error) {
            console.error('Error handling /play command:', error);
            interaction.editReply('An error occurred while trying to play the song.');
        }
    }

    if (commandName === 'stop') {
        if (currentPlayer && currentConnection) {
            currentPlayer.stop();
            await interaction.reply('⏹ Music playback has been stopped.');
        } else {
            await interaction.reply('No music is currently playing.');
        }
    }

    if (commandName === 'leave') {
        if (currentConnection) {
            currentConnection.destroy();
            currentConnection = null;
            currentPlayer = null;
            await interaction.reply('👋 The bot has left the voice channel.');
        } else {
            await interaction.reply('The bot is not connected to a voice channel.');
        }
    }
});

client.login(BOT_TOKEN);
