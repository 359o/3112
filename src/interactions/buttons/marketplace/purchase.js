import { ChannelType, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { pgDb } from '../../../utils/postgresDatabase.js';

async function ensureTable() {
  if (!pgDb.isAvailable()) await pgDb.connect();
  if (!pgDb.isAvailable()) throw new Error('PostgreSQL is not available.');
  await pgDb.pool.query(`CREATE TABLE IF NOT EXISTS marketplace_listings (
    id BIGSERIAL PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, seller_id VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL, message_id VARCHAR(20), title VARCHAR(100) NOT NULL,
    description TEXT NOT NULL DEFAULT '', price VARCHAR(50), video_url TEXT NOT NULL,
    ticket_category_id VARCHAR(20), status VARCHAR(12) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
export default {
  name: 'marketplace_purchase',
  async execute(interaction, client, args) {
    const listingId = args?.[0];
    if (!interaction.inGuild() || !listingId || listingId === 'pending') return interaction.reply({ content: 'This listing button is invalid.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ensureTable();
    const result = await pgDb.pool.query('SELECT * FROM marketplace_listings WHERE id=$1 AND guild_id=$2', [listingId,interaction.guildId]);
    const listing = result.rows[0];
    if (!listing || listing.status !== 'active') return interaction.editReply('This listing is no longer available.');
    const safeName = `purchase-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80) || `purchase-${interaction.user.id}`;
    const existing = interaction.guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic?.includes(`marketplace-listing:${listing.id};buyer:${interaction.user.id}`));
    if (existing) return interaction.editReply(`You already have a ticket for this listing: ${existing}`);
    const overwrites = [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: listing.seller_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
    ];
    const channel = await interaction.guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: listing.ticket_category_id || undefined,
      topic: `marketplace-listing:${listing.id};buyer:${interaction.user.id};seller:${listing.seller_id}`,
      permissionOverwrites: overwrites,
      reason: `Marketplace purchase ticket for listing #${listing.id}`,
    });
    const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(`Purchase: ${listing.title}`).setDescription(`${listing.description || 'No description provided.'}\n\n${listing.price ? `**Price:** ${listing.price}\n` : ''}**Buyer:** ${interaction.user}\n**Seller:** <@${listing.seller_id}>\n**Listing ID:** #${listing.id}\n\nPlease coordinate the purchase here.`).setImage(listing.video_url).setTimestamp();
    await channel.send({ content: `<@${interaction.user.id}> <@${listing.seller_id}>`, embeds: [embed] });
    return interaction.editReply(`Your private purchase ticket is ready: ${channel}`);
  },
};
