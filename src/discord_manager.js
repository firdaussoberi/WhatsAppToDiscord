const { Client, Intents } = require('discord.js');
const { downloadMediaMessage } = require('@adiwajshing/baileys');
const dcUtils = require('./discord_utils');
const waUtils = require('./whatsapp_utils');
const state = require('./state');

const client = new Client({
  intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_MESSAGE_REACTIONS],
});
let controlChannel;

const updateControlChannel = async () => {
  controlChannel = await client.channels.fetch(state.settings.ControlChannelID).catch(() => null);
};

client.on('ready', async () => {
  await updateControlChannel();
});

client.on('channelDelete', async (channel) => {
  const jid = dcUtils.channelIdToJid(channel.id);
  delete state.chats[jid];
  delete dcUtils.goccRuns[jid];
  state.settings.Categories = state.settings.Categories.filter((id) => channel.id !== id);
});

client.on('whatsappMessage', async (rawMessage, resolve) => {
  const { channelJid, senderJid } = waUtils.getWebhookAndSenderJid(rawMessage, rawMessage.key.fromMe);
  const webhook = await dcUtils.getOrCreateChannel(channelJid);
  const name = waUtils.jidToName(senderJid, rawMessage.pushName);
  const quotedName = waUtils.jidToName(rawMessage.message.extendedTextMessage?.contextInfo?.participant || '');
  const files = [];
  let content = '';

  if (rawMessage.key.participant && state.settings.WAGroupPrefix) {
    content += `[${name}] `;
  }
  let messageType = Object.keys(rawMessage.message).filter((attr) => ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(attr))[0];
  const message = rawMessage.message[messageType];
  messageType = messageType.replace('Message', '');

  switch (messageType) {
    case 'conversation':
      content += message;
      break;
    case 'extendedText':
      if (message.contextInfo?.isForwarded) {
        content += `> Forwarded Message:\n${message.text}`;
      } else if (message.contextInfo?.quotedMessage) {
        content += `> ${quotedName}: ${message.contextInfo.quotedMessage.conversation.split('\n').join('\n> ')}\n${message.text}`;
      } else if (message.canonicalUrl || message.text) {
        content += message.text;
      }
      break;
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
      if (message.fileLength.low > 8388284) {
        await webhook.send({
          content: "WA2DC Attention: Received a file, but it's over 8MB. Check WhatsApp on your phone.",
          username: name,
          avatarURL: await waUtils.getProfilePic(senderJid),
        });
        break;
      }
      files.push({
        attachment: await downloadMediaMessage(rawMessage, 'buffer', {}, { logger: state.logger, reuploadRequest: state.waClient.updateMediaMessage }),
        name: dcUtils.getFileName(message, messageType),
      });
      content += message.caption || '';
      break;
    default:
      break;
  }
  if (content || files.length) {
    content = dcUtils.partitionText(content);
    while (content.length > 1) {
      // eslint-disable-next-line no-await-in-loop
      await webhook.send({
        content: content.shift(),
        username: name,
        // eslint-disable-next-line no-await-in-loop
        avatarURL: await waUtils.getProfilePic(senderJid),
      });
    }
    const messageId = (
      await webhook.send({
        content: content.shift() || null,
        username: name,
        files,
        avatarURL: await waUtils.getProfilePic(senderJid),
      })
    ).id;
    state.lastMessages[messageId] = rawMessage.key.id;
  }
  resolve();
});

client.on('whatsappReaction', async (rawReaction, resolve) => {
  if (state.lastMessages[rawReaction.reaction.key.id]) {
    return;
  }

  const channelId = state.chats[rawReaction.key.remoteJid]?.channelId;
  if (channelId == null) {
    return;
  }
  const channel = await (await state.getGuild()).channels.fetch(channelId);

  const messageId = Object.keys(state.lastMessages).find((key) => state.lastMessages[key] === rawReaction.key.id);
  if (messageId == null) {
    return;
  }
  const message = await channel.messages.fetch(messageId);

  await message.react(rawReaction.reaction.text);
  resolve();
});

const commands = {
  ping: async (message) => {
    controlChannel.send(`Pong ${Date.now() - message.createdTimestamp}ms!`);
  },
  start: async (_message, params) => {
    if (!params.length) {
      await controlChannel.send('Please enter a phone number or name. Usage: `start <number with country code or name>`.');
      return;
    }

    // eslint-disable-next-line no-restricted-globals
    const jid = isNaN(params[0]) ? waUtils.nameToJid(params.join(' ')) : `${params[0]}@s.whatsapp.net`;
    if (!jid) {
      await controlChannel.send(`Couldn't find \`${params.join(' ')}\`.`);
      return;
    }
    await dcUtils.getOrCreateChannel(jid);

    if (state.settings.Whitelist.length) {
      state.settings.Whitelist.push(jid);
    }
  },
  list: async (_message, params) => {
    let contacts = waUtils.contactNames();
    if (params) {
      contacts = contacts.filter((name) => name.toLowerCase().includes(params.join(' ')));
    }
    controlChannel.send(contacts.length ? `\`\`\`${contacts.join('\n')}\`\`\`` : 'No results were found.');
  },
  addtowhitelist: async (message, params) => {
    const channelID = /<#(\d*)>/.exec(message)?.[1];
    if (params.length !== 1 || !channelID) {
      await controlChannel.send('Please enter a valid channel name. Usage: `addToWhitelist #<target channel>`.');
      return;
    }

    const jid = dcUtils.channelIdToJid(channelID);
    if (!jid) {
      await controlChannel.send("Couldn't find a chat with the given channel.");
      return;
    }

    state.settings.Whitelist.push(jid);
    await controlChannel.send('Added to the whitelist!');
  },
  removefromwhitelist: async (message, params) => {
    const channelID = /<#(\d*)>/.exec(message)?.[1];
    if (params.length !== 1 || !channelID) {
      await controlChannel.send('Please enter a valid channel name. Usage: `removeFromWhitelist #<target channel>`.');
      return;
    }

    const jid = dcUtils.channelIdToJid(channelID);
    if (!jid) {
      await controlChannel.send("Couldn't find a chat with the given channel.");
      return;
    }

    state.settings.Whitelist = state.settings.Whitelist.filter((el) => el !== jid);
    await controlChannel.send('Removed from the whitelist!');
  },
  listwhitelist: async () => {
    await controlChannel.send(state.settings.Whitelist.length ? `\`\`\`${state.settings.Whitelist.map((jid) => waUtils.jidToName(jid)).join('\n')}\`\`\`` : 'Whitelist is empty/inactive.');
  },
  enabledcprefix: async () => {
    state.settings.DiscordPrefix = true;
    await controlChannel.send('Discord username prefix enabled!');
  },
  disabledcprefix: async () => {
    state.settings.DiscordPrefix = false;
    await controlChannel.send('Discord username prefix disabled!');
  },
  enablewaprefix: async () => {
    state.settings.WAGroupPrefix = true;
    await controlChannel.send('WhatsApp name prefix enabled!');
  },
  disablewaprefix: async () => {
    state.settings.WAGroupPrefix = false;
    await controlChannel.send('WhatsApp name prefix disabled!');
  },
  enablewaupload: async () => {
    state.settings.UploadAttachments = true;
    await controlChannel.send('Enabled uploading files to WhatsApp!');
  },
  disablewaupload: async () => {
    state.settings.UploadAttachments = false;
    await controlChannel.send('Disabled uploading files to WhatsApp!');
  },
  help: async () => {
    await controlChannel.send(
      [
        '`start <number with country code or name>`: Starts a new conversation.',
        '`list`: Lists existing chats.',
        '`list <chat name to search>`: Finds chats that contain the given argument.',
        '`listWhitelist`: Lists all whitelisted conversations.',
        '`addToWhitelist <channel name>`: Adds specified conversation to the whitelist.',
        '`removeFromWhitelist <channel name>`: Removes specified conversation from the whitelist.',
        '`resync`: Re-syncs your contacts and groups.',
        '`enableWAUpload`: Starts uploading attachments sent to Discord to WhatsApp.',
        '`disableWAUpload`: Stop uploading attachments sent to Discord to WhatsApp.',
        '`enableDCPrefix`: Starts adding your Discord username to messages sent to WhatsApp.',
        '`disableDCPrefix`: Stops adding your Discord username to messages sent to WhatsApp.',
        "`enableWAPrefix`: Starts adding sender's name to messages sent to Discord.",
        "`disableWAPrefix`: Stops adding sender's name to messages sent to Discord.",
        '`ping`: Sends "Pong! <Now - Time Message Sent>ms" back.',
      ].join('\n'),
    );
  },
  resync: async () => {
    await state.waClient.authState.keys.set({
      'app-state-sync-version': { critical_unblock_low: null },
    });
    await state.waClient.resyncAppState(['critical_unblock_low']);
    for (const [jid, attributes] of Object.entries(await state.waClient.groupFetchAllParticipating())) {
      state.waClient.contacts[jid] = attributes.subject;
    }
    await controlChannel.send('Re-synced!');
  },
  unknownCommand: async (message) => {
    controlChannel.send(`Unknown command: \`${message.content}\`\nType \`help\` to see available commands`);
  },
};

client.on('messageCreate', async (message) => {
  //avoid recursive loop
  if (message.author === client.user) {
    return;
  }

  if (message.channel === controlChannel) {
    const command = message.content.toLowerCase().split(' ');
    await (commands[command[0]] || commands.unknownCommand)(message, command.slice(1));
  } else {
    //See: https://discord.js.org/?source=post_page---------------------------#/docs/main/stable/class/Message  
    //Note, we don't explicitly support discord components or discord stickers here  
    //must be from normal webhook bot, case for embeds, attachments etc, only assumption until something breaks
    if(message.webhookId != null){
      //could be embed, component, or stickers
      //assume if not embed, must be content, otherwise empty message (if say fully sticker)
      //if has attachment
      if (message.attachments.size != 0){ //as Collection/Map type
        //Attachment case:    
        //see whatsapp_magager.js for implementation     
        state.waClient.ev.emit('discordMessage', message); 
      }
      else{
        //Embed object case:      
        if (message.embeds.length != 0){ //Object type
          //see whatsapp_magager.js for implementation     
          state.waClient.ev.emit('discordMessage', message); 
        }
      }
    }
    else{ //assume only clean content, and not content mixed with embed etc
      state.waClient.ev.emit('discordMessage', message);      
    }
  }

});

client.on('messageReactionAdd', async (reaction, user) => {
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    reaction.message.channel.send("Couldn't send the reaction. You can only react to messages received after the bot went online.");
  }
  if (user.id === state.dcClient.user.id) {
    return;
  }
  state.waClient.ev.emit('discordReaction', { reaction, removed: false });
});

client.on('messageReactionRemove', async (reaction, user) => {
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    reaction.message.channel.send("Couldn't send the reaction. You can only react to messages received after the bot went online.");
  }
  if (user.id === state.dcClient.user.id) {
    return;
  }
  state.waClient.ev.emit('discordReaction', { reaction, removed: true });
});

module.exports = {
  start: async () => {
    await client.login(state.settings.Token);
    return client;
  },
  updateControlChannel,
};
