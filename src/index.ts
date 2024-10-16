import cron from 'node-cron';
import dotenv from 'dotenv';
import prisma from '../utils/prisma/client';
import { EntryStatus } from '@prisma/client';

dotenv.config();

// Types and interfaces
type Player = {
    id: number;
    goals_scored: number;
    own_goals: number;
    expected_goals: number;
};

// Existing functions (modified for the background service context)
async function fetchEPLPlayerData(): Promise<Player[]> {
    const response = await fetch(
        'https://fantasy.premierleague.com/api/bootstrap-static/',
        {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        }
    );

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const json = await response.json();
    return json.elements.map((player: any) => ({
        id: player.id,
        goals_scored: player.goals_scored,
        own_goals: player.own_goals,
        expected_goals: parseFloat(player.expected_goals || 0),
    }));
}

async function fetchAllEntries() {
    return prisma.entry.findMany({
        include: {
            pool: {
                include: {
                    entries: true,
                    rules: {
                        select: {
                            own_goals: true,
                        },
                    },
                },
            },
            footballers: {
                select: {
                    id: true,
                },
            },
            profile: {
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                },
            },
        },
    });
}

async function updateEntryStatistics(
    entries: any[],
    relevantPlayers: Player[]
) {
    for (const entry of entries) {
        let goals = 0;
        let ownGoals = 0;
        let expectedGoals = 0;
        let allScored = true;

        for (const footballer of entry.footballers) {
            const playerStats = relevantPlayers.find(
                (p) => p.id === footballer.id
            );
            if (playerStats) {
                goals += playerStats.goals_scored;
                ownGoals += playerStats.own_goals;
                expectedGoals += playerStats.expected_goals;
                if (playerStats.goals_scored === 0) {
                    allScored = false;
                }
            }
        }

        const netGoals = goals - ownGoals;

        let status: EntryStatus;
        if (goals > 21) {
            status = EntryStatus.BUST;
        } else if (allScored) {
            status = EntryStatus.ACTIVE;
        } else {
            status = EntryStatus.SHORT;
        }

        await prisma.entry.update({
            where: { id: entry.id },
            data: {
                goals,
                own_goals: ownGoals,
                net_goals: netGoals,
                expected_goals: parseFloat(expectedGoals.toFixed(2)),
                all_scored: allScored,
                status,
            },
        });
    }
}

async function updateEntryRankings(entries: any[]) {
    const poolsMap = new Map();

    for (const entry of entries) {
        if (entry.pool) {
            if (!poolsMap.has(entry.pool.id)) {
                poolsMap.set(entry.pool.id, []);
            }
            poolsMap.get(entry.pool.id).push(entry);
        }
    }

    for (const [poolId, poolEntries] of poolsMap) {
        const useNetGoals = poolEntries[0].pool.rules.own_goals;

        poolEntries.sort((a: any, b: any) =>
            useNetGoals ? b.net_goals - a.net_goals : b.goals - a.goals
        );

        for (let i = 0; i < poolEntries.length; i++) {
            await prisma.entry.update({
                where: { id: poolEntries[i].id },
                data: { rank: i + 1 },
            });
        }
    }
}

async function runGame(): Promise<void> {
    try {
        console.log('Running game for all profiles');
        const footballers = await prisma.footballer.findMany();
        const footballerIds = footballers.map(
            (footballer: any) => footballer.id
        );

        const eplPlayers = await fetchEPLPlayerData();

        const relevantPlayers = eplPlayers.filter((player: Player) =>
            footballerIds.includes(player.id)
        );

        const entries = await fetchAllEntries();

        if (entries.length === 0) {
            console.log('No entries found');
            return;
        }

        await updateEntryStatistics(entries, relevantPlayers);

        await updateEntryRankings(entries);

        console.log(
            'Game run successfully. Entry statistics and rankings updated.'
        );
    } catch (error) {
        console.error('Error in runGame:', error);
    }
}

// Run the job every hour
cron.schedule('0 * * * *', runGame);

// Initial run
runGame();

console.log('FPL Background service started');

// Proper shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit();
});
