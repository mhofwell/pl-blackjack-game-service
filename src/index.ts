import cron from 'node-cron';
import dotenv from 'dotenv';
import prisma from '../utils/prisma/client';
import { EntryStatus, Prisma } from '@prisma/client';

dotenv.config();

// Types and interfaces
type Player = {
    id: number;
    goals_scored: number;
    own_goals: number;
    expected_goals: number;
};

// Existing functions (modified for error handling)
async function fetchEPLPlayerData(): Promise<Player[]> {
    try {
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
    } catch (error) {
        console.error('Error fetching EPL player data:', error);
        throw error;
    }
}

async function fetchAllEntries() {
    try {
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
    } catch (error) {
        console.error('Error fetching all entries:', error);
        throw error;
    }
}

async function updateEntryStatistics(
    entries: any[],
    relevantPlayers: Player[]
) {
    for (const entry of entries) {
        try {
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
        } catch (error) {
            console.error(`Error updating entry ${entry.id}:`, error);
        }
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
        try {
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
        } catch (error) {
            console.error(`Error updating rankings for pool ${poolId}:`, error);
        }
    }
}

async function runGame(): Promise<void> {
    // get current time
    const currentTime = new Date();

    // convert to human readable time
    const dateTime = currentTime.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    });

    try {
        console.log(`Running game for all profiles at ${dateTime}`);
        const footballers = await prisma.footballer.findMany();
        const footballerIds = footballers.map((footballer) => footballer.id);

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
        if (error instanceof Prisma.PrismaClientInitializationError) {
            console.error(
                'Failed to initialize Prisma client. Please check your DATABASE_URL environment variable.'
            );
        } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
            console.error('Known Prisma error occurred:', error.message);
        } else if (error instanceof Prisma.PrismaClientUnknownRequestError) {
            console.error('Unknown Prisma error occurred:', error.message);
        } else {
            console.error('Unexpected error in runGame:', error);
        }
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
