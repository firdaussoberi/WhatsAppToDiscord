const { default: makeWASocket, fetchLatestBaileysVersion } = require('@adiwajshing/baileys');
const waUtils = require('./whatsapp_utils');
const dcUtils = require('./discord_utils');
const state = require('./state');

let authState;
let saveState;

const connectToWhatsApp = async (retry = 1) => {
  const controlChannel = await state.getControlChannel();
  const { version } = await fetchLatestBaileysVersion();

  const client = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: authState,
    logger: state.logger,
    markOnlineOnConnect: false,
  });
  client.contacts = state.contacts;

  client.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      await waUtils.sendQR(qr);
    }
    if (connection === 'close') {
      state.logger.error(lastDisconnect.error);
      if (retry <= 3) {
        await controlChannel.send(`WhatsApp connection failed! Trying to reconnect! Retry #${retry}`);
        await connectToWhatsApp(retry + 1);
      } else if (retry <= 5) {
        const delay = (retry - 3) * 10;
        await controlChannel.send(`WhatsApp connection failed! Waiting ${delay} seconds before trying to reconnect! Retry #${retry}.`);
        await new Promise((resolve) => {
          setTimeout(resolve, delay * 1000);
        });
        await connectToWhatsApp(retry + 1);
      } else {
        await controlChannel.send('Failed connecting 5 times. Please rescan the QR code.');
        await module.exports.start(true);
      }
    } else if (connection === 'open') {
      state.waClient = client;
      // eslint-disable-next-line no-param-reassign
      retry = 1;
      await controlChannel.send('WhatsApp connection successfully opened!');
    }
  });
  client.ev.on('creds.update', saveState);
  ['chats.set', 'contacts.set', 'chats.upsert', 'chats.update', 'contacts.upsert', 'contacts.update', 'groups.upsert', 'groups.update'].forEach((eventName) => client.ev.on(eventName, waUtils.updateContacts));

  client.ev.on('messages.upsert', async (update) => {
    if (update.type === 'notify') {
      for await (const message of update.messages) {
        if (state.settings.Whitelist.length && !state.settings.Whitelist.includes(message.key.remoteJid)) {
          return;
        }
        if (state.startTime > message.messageTimestamp) {
          return;
        }
        if (!['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].some((el) => Object.keys(message.message || {}).includes(el))) {
          return;
        }
        await new Promise((resolve) => {
          state.dcClient.emit('whatsappMessage', message, resolve);
        });
      }
    }
  });

  client.ev.on('messages.reaction', async (reactions) => {
    for await (const reaction of reactions) {
      if (state.settings.Whitelist.length && !state.settings.Whitelist.includes(reaction.key.remoteJid)) {
        return;
      }
      if (state.startTime > reaction.messageTimestamp) {
        return;
      }
      await new Promise((resolve) => {
        state.dcClient.emit('whatsappReaction', reaction, resolve);
      });
    }
  });

  client.ev.on('discordMessage', async (message) => {

    const jid = dcUtils.channelIdToJid(message.channel.id);

    if (!jid) {
      if (!state.settings.Categories.includes(message.channel?.parent?.id)) {
        return;
      }
      message.channel.send("Couldn't find the user. Restart the bot, or manually delete this channel and start a new chat using the `start` command.");
      return;
    }

    const content = {};
    const options = {};

    if (state.settings.UploadAttachments) {
      await Promise.all([...message.attachments.values()].map((attachment) => client.sendMessage(jid, waUtils.createDocumentContent(attachment))));
      if (!message.content) {
        if(message.embeds.length > 0){
          message.content = "Embed"
          message.cleanContent = "Embed"
        }
        if(message.attachments.size > 0){
          message.content = "Attachments"
          message.cleanContent = "Attachments"
        }
      }
      content.text = message.content;
    } else {
      content.text = [message.content, ...message.attachments.map((el) => el.url)].join(' ');
    }

    if (state.settings.DiscordPrefix) {
      content.text = `[${message.member?.nickname || message.author.username}] ${content.text}`;
    }

    if (message.reference) {
      options.quoted = await waUtils.createQuoteMessage(message);
      if (options.quoted == null) {
        message.channel.send("Couldn't find the message quoted. You can only reply to messages received after the bot went online. Sending the message without the quoted message.");
      }
    }

    //Embed object type, loop per object
    if (message.embeds.length != 0){ 
      for (var i = 0; i < message.embeds.length; i++){
        content.text = JSON.stringify(message.embeds[i]);
        state.lastMessages[message.id] = (await client.sendMessage(jid, content, options)).key.id;
      }        
    }
    //Non-Embed type
    else{
      state.lastMessages[message.id] = (await client.sendMessage(jid, content, options)).key.id;      
    }

  });

  client.ev.on('discordReaction', async ({ reaction, removed }) => {
    const jid = dcUtils.channelIdToJid(reaction.message.channelId);
    if (!jid) {
      reaction.message.channel.send("Couldn't find the user. Restart the bot, or manually delete this channel and start a new chat using the `start` command.");
      return;
    }

    const key = {
      id: state.lastMessages[reaction.message.id],
      fromMe: reaction.message.webhookId == null || reaction.message.author.username === 'You',
      remoteJid: jid,
    };

    if (jid.endsWith('@g.us')) {
      key.participant = waUtils.nameToJid(reaction.message.author.username);
    }

    const messageId = (
      await client.sendMessage(jid, {
        react: {
          text: removed ? '' : reaction.emoji.name,
          key,
        },
      })
    ).key.id;
    state.lastMessages[messageId] = true;
  });
};

module.exports = {
  start: async (newSession = false) => {
    ({ authState, saveState } = await waUtils.useStorageAuthState(newSession));
    await connectToWhatsApp();
  },
};
