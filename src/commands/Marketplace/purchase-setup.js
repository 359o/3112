import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, MessageFlags,
} from 'discord.js';
import { pgDb } from '../../utils/postgresDatabase.js';

const SELLER_ROLE_NAME = 'Pack Seller';
async function ensureTable() {
  if (!pgDb.isAvailable()) await pgDb.connect();
  if (!pgDb.isAvailable()) throw new Error('PostgreSQL is not available. Check the bot database configuration.');
  await pgDb.pool.query(`CREATE TABLE IF NOT EXISTS marketplace_listings (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL,
    seller_id VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL,
    message_id VARCHAR(20),
    title VARCHAR(100) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price VARCHAR(50),
    video_url TEXT NOT NULL,
    ticket_category_id VARCHAR(20),
    status VARCHAR(12) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pgDb.pool.query('CREATE INDEX IF NOT EXISTS idx_marketplace_listings_guild ON marketplace_listings(guild_id, status)');
}
function hasSellerRole(interaction) {
  return interaction.member?.roles?.cache?.some(role => role.name.toLowerCase() === SELLER_ROLE_NAME.toLowerCase());
}
async function denyUnlessSeller(interaction) {
  if (!hasSellerRole(interaction)) {
    await interaction.reply({ content: `You need the **${SELLER_ROLE_NAME}** role to manage marketplace listings.`, flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('purchase-setup')
    .setDescription('Create and manage marketplace listings (Pack Seller role required).')
    .addSubcommand(s => s.setName('create').setDescription('Post a product video and Purchase button.')
      .addStringOption(o => o.setName('title').setDescription('Product or pack name').setRequired(true).setMaxLength(100))
      .addAttachmentOption(o => o.setName('video').setDescription('Upload the product video').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post the listing in').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Product description').setRequired(false).setMaxLength(1000))
      .addStringOption(o => o.setName('price').setDescription('Optional price, e.g. $10').setRequired(false).setMaxLength(50))
      .addChannelOption(o => o.setName('ticket-category').setDescription('Category for private purchase tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(false)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit one of your listings.')
      .addIntegerOption(o => o.setName('id').setDescription('Listing ID').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('title').setDescription('New title').setRequired(false).setMaxLength(100))
      .addStringOption(o => o.setName('description').setDescription('New description').setRequired(false).setMaxLength(1000))
      .addStringOption(o => o.setName('price').setDescription('New price (use “free” to remove price)').setRequired(false).setMaxLength(50)))
    .addSubcommand(s => s.setName('delete').setDescription('Delete one of your listings.')
      .addIntegerOption(o => o.setName('id').setDescription('Listing ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('list').setDescription('List your marketplace listings.'))
    .addSubcommand(s => s.setName('pause').setDescription('Pause one of your listings.')
      .addIntegerOption(o => o.setName('id').setDescription('Listing ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('resume').setDescription('Resume one of your listings.')
      .addIntegerOption(o => o.setName('id').setDescription('Listing ID').setRequired(true).setMinValue(1))),

  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    if (!await denyUnlessSeller(interaction)) return;
    await ensureTable();
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const sellerId = interaction.user.id;

    if (sub === 'create') {
      const video = interaction.options.getAttachment('video');
      if (!video.contentType?.startsWith('video/')) return interaction.reply({ content: 'Please upload a valid video file.', flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel('channel');
      const category = interaction.options.getChannel('ticket-category');
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description') || '';
      const price = interaction.options.getString('price');
      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(title).setDescription(`${description ? `${description}\n\n` : ''}${price ? `**Price:** ${price}\n` : ''}**Seller:** <@${sellerId}>`).setFooter({ text: 'Titan Bot Marketplace' }).setTimestamp();
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('marketplace_purchase:pending').setLabel('🛒 Purchase').setStyle(ButtonStyle.Success));
      // Create the listing row first to get a stable ID for its button custom ID.
      const inserted = await pgDb.pool.query(`INSERT INTO marketplace_listings (guild_id,seller_id,channel_id,title,description,price,video_url,ticket_category_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [guildId,sellerId,channel.id,title,description,price,video.url,category?.id || null]);
      const id = inserted.rows[0].id;
      row.components[0].setCustomId(`marketplace_purchase:${id}`);
      try {
        const message = await channel.send({ content: video.url, embeds: [embed], components: [row] });
        await pgDb.pool.query('UPDATE marketplace_listings SET message_id=$1 WHERE id=$2', [message.id,id]);
        return interaction.reply({ content: `Listing **#${id}** posted in ${channel}.`, flags: MessageFlags.Ephemeral });
      } catch (error) {
        await pgDb.pool.query('DELETE FROM marketplace_listings WHERE id=$1', [id]);
        throw error;
      }
    }

    if (sub === 'list') {
      const result = await pgDb.pool.query('SELECT id,title,status,price FROM marketplace_listings WHERE guild_id=$1 AND seller_id=$2 ORDER BY id DESC LIMIT 25', [guildId,sellerId]);
      const text = result.rows.length ? result.rows.map(r => `**#${r.id}** — ${r.title} · ${r.status}${r.price ? ` · ${r.price}` : ''}`).join('\n') : 'You have no listings yet.';
      return interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }

    const id = interaction.options.getInteger('id');
    const found = await pgDb.pool.query('SELECT * FROM marketplace_listings WHERE id=$1 AND guild_id=$2 AND seller_id=$3', [id,guildId,sellerId]);
    const listing = found.rows[0];
    if (!listing) return interaction.reply({ content: 'Listing not found, or it does not belong to you.', flags: MessageFlags.Ephemeral });

    if (sub === 'delete') {
      await pgDb.pool.query('DELETE FROM marketplace_listings WHERE id=$1', [id]);
      const channel = await interaction.guild.channels.fetch(listing.channel_id).catch(() => null);
      const message = channel ? await channel.messages.fetch(listing.message_id).catch(() => null) : null;
      if (message) await message.delete().catch(() => {});
      return interaction.reply({ content: `Listing **#${id}** deleted.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'pause' || sub === 'resume') {
      const status = sub === 'pause' ? 'paused' : 'active';
      await pgDb.pool.query('UPDATE marketplace_listings SET status=$1,updated_at=NOW() WHERE id=$2', [status,id]);
      const channel = await interaction.guild.channels.fetch(listing.channel_id).catch(() => null);
      const message = channel ? await channel.messages.fetch(listing.message_id).catch(() => null) : null;
      if (message) {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`marketplace_purchase:${id}`).setLabel(status === 'active' ? '🛒 Purchase' : '⏸ Listing Paused').setStyle(status === 'active' ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(status !== 'active'));
        await message.edit({ components: [row] }).catch(() => {});
      }
      return interaction.reply({ content: `Listing **#${id}** ${status}.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'edit') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const price = interaction.options.getString('price');
      if (title === null && description === null && price === null) return interaction.reply({ content: 'Provide at least one field to edit.', flags: MessageFlags.Ephemeral });
      const newTitle = title ?? listing.title;
      const newDescription = description ?? listing.description;
      const newPrice = price === null ? listing.price : (price.toLowerCase() === 'free' ? null : price);
      await pgDb.pool.query('UPDATE marketplace_listings SET title=$1,description=$2,price=$3,updated_at=NOW() WHERE id=$4', [newTitle,newDescription,newPrice,id]);
      const channel = await interaction.guild.channels.fetch(listing.channel_id).catch(() => null);
      const message = channel ? await channel.messages.fetch(listing.message_id).catch(() => null) : null;
      if (message) {
        const embed = EmbedBuilder.from(message.embeds[0] || new EmbedBuilder()).setTitle(newTitle).setDescription(`${newDescription ? `${newDescription}\n\n` : ''}${newPrice ? `**Price:** ${newPrice}\n` : ''}**Seller:** <@${sellerId}>`);
        await message.edit({ embeds: [embed] }).catch(() => {});
      }
      return interaction.reply({ content: `Listing **#${id}** updated.`, flags: MessageFlags.Ephemeral });
    }
  },
};
