const { REST, Routes } = require('discord.js');

// Replace with your actual Application ID and Bot Token
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Define the slash commands
const commands = [
    {
        name: 'play',
        description: 'Play a song from a YouTube URL',
        options: [
            {
                name: 'url',
                type: 3, // STRING type
                description: 'The YouTube URL',
                required: true,
            },
        ],
    },
    {
        name: 'pause',
        description: 'Pause the currently playing music',
    },
    {
        name: 'resume',
        description: 'Resume the paused music',
    },
    {
        name: 'stop',
        description: 'Stop the currently playing music',
    },
    {
        name: 'leave',
        description: 'Make the bot leave the voice channel',
    },
    {
        name: 'volume',
        description: 'Set the volume of the music playback',
        options: [
            {
                name: 'volume',
                type: 4, // INTEGER type
                description: 'The volume level (0-100)',
                required: true,
            },
        ],
    },
    {
        name: 'progress',
        description: 'Display the progress of the currently playing song',
    },
];

// Initialize REST API client
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // Register the commands for the specific server
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
            body: commands,
        });

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
})();
