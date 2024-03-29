import fs from 'fs';
import { ref } from 'vue';
import {
    GameSettings,
    LeagueSettings,
    RankedStats,
    inputSettings
} from '../types';
import axios from 'axios';
import https from 'https';
import { ipcRenderer } from 'electron';

export const useLeagueLCUAPI = () => {
    const clientName = ref<string>('');
    const pid = ref<string>('');
    const port = ref<string>('');
    const password = ref<string>('');
    const method = ref<string>('');
    const auth = ref({
        username: 'riot',
        password: password.value
    });
    const httpsAgent = new https.Agent({
        rejectUnauthorized: false
    });
    const baseUrl = ref<string>(`${method.value}://127.0.0.1:${port.value}`);

    function sleep(s: number) {
        return new Promise(resolve => setTimeout(resolve, s * 1000));
    }

    function refreshLockfile() {
        const lockfilePath = `${process.env['LEAGUE_LOCKFILE']}/lockfile`;
        if (!fs.existsSync(`${process.env['LEAGUE_LOCKFILE']}/lockfile`)) {
            throw new Error("League of Legends n'a pas été détecté");
        }
        [
            clientName.value,
            pid.value,
            port.value,
            password.value,
            method.value
        ] = fs.readFileSync(`${lockfilePath}`, 'utf-8').split(':');
        baseUrl.value = `${method.value}://127.0.0.1:${port.value}`;
        auth.value.password = password.value;
    }

    async function checkIsLoggedIn(id: number = -1): Promise<boolean> {
        if (id === 0) return false;
        try {
            refreshLockfile();
            const response = await axios.get(
                `${baseUrl.value}/lol-login/v1/session`,
                {
                    auth: auth.value,
                    httpsAgent
                }
            );
            if (response.status !== 200 || !response.data.summonerId)
                throw new Error('Not logged in');
            if (id === -1) return true;
            return response.data.summonerId === id;
        } catch (error) {
            return false;
        }
    }

    async function waitIsLoggedIn() {
        let count = 0;
        while (true) {
            const response = await checkIsLoggedIn();
            if (response) {
                break;
            }
            await sleep(1);
            console.log('waitIsLoggedIn');
            count++;
            if (count > 50) {
                throw new Error(
                    'Une erreur est survenue lors de la récupération des statistiques'
                );
            }
        }
        return true;
    }

    async function getSummonerInfo(): Promise<{
        summoner_name: string;
        iconId: number;
        level: number;
        id: number;
    }> {
        await waitIsLoggedIn();
        const endpoint = `${baseUrl.value}/lol-summoner/v1/current-summoner`;
        let response = null;

        response = await axios.get(endpoint, {
            auth: auth.value,
            httpsAgent
        });
        const iconId = response.data.profileIconId;
        if (!fs.existsSync(`${process.env['RESOURCES_FOLDER']}profileIcons`)) {
            fs.mkdirSync(`${process.env['RESOURCES_FOLDER']}profileIcons`);
        }
        if (
            !fs.existsSync(
                `${process.env['RESOURCES_FOLDER']}profileIcons/${iconId}.png`
            )
        ) {
            ipcRenderer.send(
                'download-image',
                `http://ddragon.leagueoflegends.com/cdn/13.14.1/img/profileicon/${iconId}.png`,
                `${process.env['RESOURCES_FOLDER']}profileIcons/${iconId}.png`,
                response.data.summonerId
            );
        }

        return {
            summoner_name: response.data.displayName,
            iconId,
            level: response.data.summonerLevel,
            id: response.data.summonerId
        };
    }

    async function getSummonerWallet(): Promise<{ rp: number; be: number }> {
        await waitIsLoggedIn();
        const endpoint = `${baseUrl.value}/lol-inventory/v1/wallet`;
        const response = await axios.get(endpoint, {
            auth: auth.value,
            httpsAgent,
            params: {
                currencyTypes: "[\"lol_blue_essence\",\"RP\"]"
            }
        });
        return {
            rp: response.data.RP,
            be: response.data.lol_blue_essence
        };
    }

    async function getCurrentSummonerRankedData(): Promise<RankedStats> {
        await waitIsLoggedIn();
        const endpoint = `${baseUrl.value}/lol-ranked/v1/current-ranked-stats`;
        let response = null;
        let count = 0;
        while (true) {
            try {
                response = await axios.get(endpoint, {
                    auth: auth.value,
                    httpsAgent
                });
                break;
            } catch (error) {
                await sleep(1);
                count++;
                if (count > 40) {
                    throw new Error(
                        'Une erreur est survenue lors de la récupération des statistiques'
                    );
                }
            }
        }
        const soloQStats = response.data.queues.find(
            (queue: any) => queue.queueType === 'RANKED_SOLO_5x5'
        );

        return {
            tier: soloQStats.tier,
            division: soloQStats.division,
            leaguePoints: soloQStats.leaguePoints,
            miniSeriesProgress: soloQStats.miniSeriesProgress,
            wins: soloQStats.wins,
            losses: soloQStats.losses,
            isProvisional: soloQStats.isProvisional
        };
    }

    async function getOwnedChampions(): Promise<string[]> {
        await waitIsLoggedIn();
        const endpoint = `${baseUrl.value}/lol-champions/v1/owned-champions-minimal`;
        const response = await axios.get(endpoint, {
            auth: auth.value,
            httpsAgent
        });
        return response.data.reduce((acc: string[], cur: any) => {
            if (!cur.ownership.owned) return acc;
            acc.push(cur.name);
            if (
                !fs.existsSync(
                    `${process.env['RESOURCES_FOLDER']}championTiles`
                )
            )
                fs.mkdirSync(`${process.env['RESOURCES_FOLDER']}championTiles`);
            if (
                !fs.existsSync(
                    `${process.env['RESOURCES_FOLDER']}championTiles/${cur.name}.png`
                )
            ) {
                if (cur.alias === 'FiddleSticks') cur.alias = 'Fiddlesticks';
                ipcRenderer.send(
                    'download-champ-image',
                    `${method.value}://127.0.0.1:${port.value}${cur.squarePortraitPath}`,
                    `${process.env['RESOURCES_FOLDER']}championTiles/${cur.name}.png`,
                    { ...auth.value }
                );
            }
            return acc;
        }, [] as string[]);
    }

    async function getSummonerSettings(): Promise<LeagueSettings> {
        await waitIsLoggedIn();
        const gameSettingsEndpoint = `${baseUrl.value}/lol-game-settings/v1/game-settings`;
        const inputSettingsEndpoint = `${baseUrl.value}/lol-game-settings/v1/input-settings`;

        const gameSettingsResponse = await axios.get<GameSettings>(
            gameSettingsEndpoint,
            {
                auth: auth.value,
                httpsAgent
            }
        );
        const inputSettingsResponse = await axios.get<inputSettings>(
            inputSettingsEndpoint,
            {
                auth: auth.value,
                httpsAgent
            }
        );

        return {
            gameSettings: gameSettingsResponse.data,
            inputSettings: inputSettingsResponse.data
        };
    }

    async function patchSummonerSettings(
        leagueSettings: LeagueSettings
    ): Promise<void> {
        await waitIsLoggedIn();
        const gameSettingsEndpoint = `${baseUrl.value}/lol-game-settings/v1/game-settings`;
        const inputSettingsEndpoint = `${baseUrl.value}/lol-game-settings/v1/input-settings`;

        await axios.patch(
            gameSettingsEndpoint,
            {
                ...leagueSettings.gameSettings
            },
            {
                auth: auth.value,
                httpsAgent
            }
        );
        await axios.patch(
            inputSettingsEndpoint,
            {
                ...leagueSettings.inputSettings
            },
            {
                auth: auth.value,
                httpsAgent
            }
        );
        return;
    }

    return {
        getCurrentSummonerRankedData,
        getSummonerInfo,
        checkIsLoggedIn,
        getSummonerSettings,
        patchSummonerSettings,
        getOwnedChampions,
        getSummonerWallet
    };
};
