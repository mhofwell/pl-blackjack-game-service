// src/index.ts

import cron from 'node-cron';
import axios from 'axios';
import dotenv from 'dotenv';
import prisma from '../utils/prisma/client';

dotenv.config();

// FPL API base URL
const FPL_API_BASE_URL = 'https://fantasy.premierleague.com/api';

interface FPLData {
    generalInfo: any;
    fixtures: any[];
}

interface GameState {
    timestamp: Date;
    totalPlayers: number;
    currentGameweek: number;
    upcomingFixtures: any[];
}

async function fetchFPLData(): Promise<FPLData> {
    try {
        const generalInfo = await axios.get(
            `${FPL_API_BASE_URL}/bootstrap-static/`
        );
        const fixtures = await axios.get(`${FPL_API_BASE_URL}/fixtures/`);

        return {
            generalInfo: generalInfo.data,
            fixtures: fixtures.data,
        };
    } catch (error) {
        console.error('Error fetching FPL data:', error);
        throw error;
    }
}

async function processAndSaveGameState(fplData: FPLData): Promise<void> {
    const gameState: GameState = {
        timestamp: new Date(),
        totalPlayers: fplData.generalInfo.total_players,
        currentGameweek: fplData.generalInfo.current_event,
        upcomingFixtures: fplData.fixtures
            .filter((f) => f.finished === false)
            .slice(0, 5),
    };

    try {
        await prisma.gameState.create({
            data: gameState,
        });
        console.log('Game state updated successfully');
    } catch (error) {
        console.error('Error saving game state:', error);
        throw error;
    }
}

async function updateGameState(): Promise<void> {
    try {
        const fplData = await fetchFPLData();
        await processAndSaveGameState(fplData);
    } catch (error) {
        console.error('Error in updateGameState:', error);
    }
}

// Run the job every hour
cron.schedule('0 * * * *', updateGameState);

// Initial run
updateGameState();

console.log('FPL Background service started');

// Proper shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit();
});
