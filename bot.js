const { Client, GatewayIntentBits } = require('discord.js');
const { IgApiClient } = require('instagram-private-api');
const mongoose = require('mongoose');
const http = require('http');
require('dotenv').config();

// Inicjalizacja klienta Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
    ]
});

// Inicjalizacja Instagram API
const ig = new IgApiClient();

// Model użytkownika w MongoDB
const VerifiedUser = mongoose.model('VerifiedUser', {
    discordId: String,
    discordUsername: String,
    igUsername: String,
    verifiedAt: Date,
    guildId: String
});

// Mapa kodów weryfikacyjnych
const verificationCodes = new Map();

// Połączenie z MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Połączono z MongoDB!');
}).catch(err => {
    console.error('Błąd połączenia z MongoDB:', err);
});

// Funkcje pomocnicze
function generateVerificationCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function isUserVerified(discordId) {
    return await VerifiedUser.exists({ discordId });
}

async function saveVerifiedUser(userData) {
    const newUser = new VerifiedUser(userData);
    await newUser.save();
}

// Walidacja konta Instagram
async function validateInstagramAccount(user) {
    try {
        const userInfo = await ig.user.info(user.pk);
        
        const criteria = {
            minFollowers: userInfo.follower_count >= 10,
            minFollowing: userInfo.following_count >= 5
        };

        const failedCriteria = Object.entries(criteria)
            .filter(([, passes]) => !passes)
            .map(([name]) => name);

        if (failedCriteria.length > 0) {
            let message = 'Twoje konto nie spełnia następujących wymagań:\n';
            failedCriteria.forEach(criteria => {
                switch(criteria) {
                    case 'minFollowers':
                        message += '- Minimum 10 followersów\n';
                        break;
                    case 'minFollowing':
                        message += '- Musisz followować minimum 5 profili\n';
                        break;
                    case 'accountAge':
                        message += '- Konto musi być starsze niż 30 dni\n';
                        break;
                }
            });
            return { isValid: false, message };
        }

        return { isValid: true, message: 'Konto spełnia wymagania.' };
    } catch (error) {
        console.error('Błąd walidacji konta:', error);
        return { isValid: false, message: 'Wystąpił błąd podczas sprawdzania konta.' };
    }
}

// Sprawdzanie Instagrama
async function checkInstagramFollow(igUsername, verificationCode) {
    try {
        ig.state.generateDevice(process.env.IG_USERNAME);
        await ig.account.login(process.env.IG_USERNAME, process.env.IG_PASSWORD);
        
        const user = await ig.user.searchExact(igUsername);
        if (!user) {
            return { success: false, message: 'Nie znaleziono użytkownika na Instagramie.' };
        }

        const validation = await validateInstagramAccount(user);
        if (!validation.isValid) {
            return { success: false, message: validation.message };
        }

        const friendship = await ig.friendship.show(user.pk);
        if (!friendship.followed_by) {
            return { success: false, message: 'Użytkownik nie followuje jeszcze profilu.' };
        }

        // Sprawdź wiadomości w głównej skrzynce
        const inbox = await ig.feed.directInbox().items();
        let verificationMessage = inbox.find(thread => 
            thread.users[0].username.toLowerCase() === igUsername.toLowerCase() &&
            thread.last_permanent_item.text === verificationCode
        );

        // Sprawdź requesty wiadomości
        if (!verificationMessage) {
            const pendingInbox = await ig.feed.directPending().items();
            verificationMessage = pendingInbox.find(thread => 
                thread.users[0].username.toLowerCase() === igUsername.toLowerCase() &&
                thread.last_permanent_item.text === verificationCode
            );

            if (verificationMessage) {
                await ig.directThread.approve(verificationMessage.thread_id);
            }
        }

        if (!verificationMessage) {
            return { 
                success: false, 
                message: 'Nie znaleziono wiadomości z kodem weryfikacyjnym. Upewnij się, że wysłałeś kod w wiadomości prywatnej.' 
            };
        }

        return { success: true };
    } catch (error) {
        console.error('Błąd weryfikacji Instagram:', error);
        return { 
            success: false, 
            message: 'Wystąpił błąd podczas weryfikacji. Spróbuj ponownie za chwilę.' 
        };
    }
}

// Obsługa komend na serwerze
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Komenda !verify na serwerze
    if (message.content === '!verify' && message.guild) {
        // Sprawdź czy użytkownik nie jest już zweryfikowany
        const isVerified = await isUserVerified(message.author.id);
        if (isVerified) {
            return message.reply('Jesteś już zweryfikowany!');
        }

        const code = generateVerificationCode();
        verificationCodes.set(message.author.id, {
            code,
            timestamp: Date.now()
        });

        try {
            await message.author.send(
                `Witaj! Aby rozpocząć weryfikację:\n\n` +
                `1. Zaobserwuj profil **${process.env.IG_USERNAME}** na Instagramie\n` +
                `2. Wyślij następujący kod w wiadomości prywatnej na Instagramie: **${code}**\n` +
                `3. Po wykonaniu powyższych kroków, napisz tutaj: !verify <twoja_nazwa_użytkownika_instagram>\n\n` +
                `Kod jest ważny przez 30 minut.`
            );
            await message.reply('Wysłałem instrukcje weryfikacji w prywatnej wiadomości! 📬');
        } catch (error) {
            await message.reply('Nie mogę wysłać Ci prywatnej wiadomości. Upewnij się, że masz włączone DM na tym serwerze.');
        }
    }

    // Komenda do sprawdzania zweryfikowanych użytkowników
    if (message.content === '!verified-users' && message.member.permissions.has('ADMINISTRATOR')) {
        const users = await VerifiedUser.find({ guildId: message.guild.id });
        
        if (users.length === 0) {
            return message.reply('Brak zweryfikowanych użytkowników.');
        }

        let reply = '**Zweryfikowani użytkownicy:**\n';
        for (const user of users) {
            reply += `- Discord: ${user.discordUsername}, Instagram: ${user.igUsername}, Data: ${user.verifiedAt.toLocaleDateString()}\n`;
        }
        
        await message.reply(reply);
    }
});

// Obsługa weryfikacji w DM
client.on('messageCreate', async (message) => {
    if (message.author.bot || message.guild) return;

    if (message.content.startsWith('!verify')) {
        const igUsername = message.content.split(' ')[1];
        
        if (!igUsername) {
            return message.reply('Użyj: !verify <nazwa_użytkownika_instagram>');
        }

        const verification = verificationCodes.get(message.author.id);
        
        if (!verification) {
            return message.reply('Najpierw użyj komendy !verify na serwerze.');
        }

        if (Date.now() - verification.timestamp > 1800000) {
            verificationCodes.delete(message.author.id);
            return message.reply('Kod weryfikacyjny wygasł. Użyj !verify ponownie na serwerze.');
        }

        const result = await checkInstagramFollow(igUsername, verification.code);

        if (result.success) {
            try {
                const guilds = client.guilds.cache;
                let verified = false;

                for (const [, guild] of guilds) {
                    try {
                        const member = await guild.members.fetch(message.author.id);
                        if (member) {
                            await member.roles.add(process.env.VERIFIED_ROLE_ID);
                            verified = true;

                            // Zapisz w bazie danych
                            await saveVerifiedUser({
                                discordId: message.author.id,
                                discordUsername: message.author.tag,
                                igUsername: igUsername,
                                verifiedAt: new Date(),
                                guildId: guild.id
                            });
                        }
                    } catch (e) {
                        console.error(`Nie można nadać roli na serwerze ${guild.name}:`, e);
                    }
                }

                if (verified) {
                    verificationCodes.delete(message.author.id);
                    await message.reply('Weryfikacja udana! Nadano rolę. ✅');
                } else {
                    await message.reply('Weryfikacja się powiodła, ale nie mogę znaleźć Cię na serwerze. Spróbuj ponownie później.');
                }
            } catch (error) {
                console.error('Błąd nadawania roli:', error);
                await message.reply('Wystąpił błąd podczas nadawania roli.');
            }
        } else {
            await message.reply(`Weryfikacja nieudana: ${result.message}`);
        }
    }
});

// Serwer HTTP dla Render
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
});
server.listen(3000);

// Ping co 14 minut żeby bot nie zasypiał
setInterval(() => {
    http.get(`http://${process.env.RENDER_EXTERNAL_URL}`);
}, 840000);

client.once('ready', () => {
    console.log('Bot jest gotowy! 🚀');
});

client.login(process.env.DISCORD_TOKEN);
