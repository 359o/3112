import { ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getFromDb, setInDb, deleteFromDb } from '../utils/database.js';
import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from './config/guildConfig.js';

/**
 * Checks if a member has the "Pack Seller" role or Administrator permissions.
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
export function isPackSeller(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  return member.roles?.cache?.some((r) => {
    const name = r.name.toLowerCase().trim();
    return name === 'pack seller' || name === 'packseller' || name === 'seller';
  }) ?? false;
}

/**
 * Key generators for marketplace data in DB (routes to persistent temp_data or memory)
 */
export const getListingKey = (guildId, listingId) => `temp:marketplace:listing:${guildId}:${listingId}`;
export const getListingsIndexKey = (guildId) => `temp:marketplace:listings:${guildId}`;
export const getPurchaseTicketKey = (guildId, channelId) => `temp:marketplace:ticket:${guildId}:${channelId}`;
export const getBuyerActiveTicketKey = (guildId, buyerId, listingId) =>
  `temp:marketplace:buyer_ticket:${guildId}:${buyerId}:${listingId}`;

/**
 * Save a new or updated marketplace listing.
 */
export async function saveListing(guildId, listing) {
  try {
    const listingKey = getListingKey(guildId, listing.id);
    await setInDb(listingKey, listing);

    const indexKey = getListingsIndexKey(guildId);
    const existingList = await getFromDb(indexKey, []);
    const listingIds = Array.isArray(existingList) ? existingList : [];

    if (!listingIds.includes(listing.id)) {
      listingIds.push(listing.id);
      await setInDb(indexKey, listingIds);
    }

    logger.info(`Marketplace listing saved: ${listing.id} in guild ${guildId}`);
    return true;
  } catch (error) {
    logger.error(`Error saving marketplace listing ${listing?.id}:`, error);
    return false;
  }
}

/**
 * Retrieve a listing by ID.
 */
export async function getListing(guildId, listingId) {
  try {
    const key = getListingKey(guildId, listingId);
    return await getFromDb(key, null);
  } catch (error) {
    logger.error(`Error getting marketplace listing ${listingId}:`, error);
    return null;
  }
}

/**
 * Retrieve all listings for a guild.
 */
export async function getAllListings(guildId) {
  try {
    const indexKey = getListingsIndexKey(guildId);
    const listingIds = await getFromDb(indexKey, []);
    if (!Array.isArray(listingIds) || listingIds.length === 0) {
      return [];
    }

    const listings = [];
    for (const id of listingIds) {
      const item = await getListing(guildId, id);
      if (item && item.status !== 'deleted') {
        listings.push(item);
      }
    }
    return listings;
  } catch (error) {
    logger.error(`Error retrieving all listings for guild ${guildId}:`, error);
    return [];
  }
}

/**
 * Retrieve all active listings created by a specific seller.
 */
export async function getListingsBySeller(guildId, sellerId) {
  const all = await getAllListings(guildId);
  return all.filter((item) => item.sellerId === sellerId);
}

/**
 * Delete a listing by ID.
 */
export async function deleteListing(guildId, listingId) {
  try {
    const key = getListingKey(guildId, listingId);
    const listing = await getFromDb(key, null);

    if (listing) {
      listing.status = 'deleted';
      await setInDb(key, listing);
    }

    const indexKey = getListingsIndexKey(guildId);
    const existingList = await getFromDb(indexKey, []);
    if (Array.isArray(existingList)) {
      const updated = existingList.filter((id) => id !== listingId);
      await setInDb(indexKey, updated);
    }

    logger.info(`Marketplace listing deleted: ${listingId} in guild ${guildId}`);
    return true;
  } catch (error) {
    logger.error(`Error deleting marketplace listing ${listingId}:`, error);
    return false;
  }
}

/**
 * Check if a buyer already has an open ticket for this specific listing.
 */
export async function getActivePurchaseTicket(guildId, buyerId, listingId) {
  try {
    const key = getBuyerActiveTicketKey(guildId, buyerId, listingId);
    return await getFromDb(key, null);
  } catch (error) {
    logger.error('Error checking active purchase ticket:', error);
    return null;
  }
}

/**
 * Create an independent private purchase ticket for a buyer and seller.
 */
export async function createPurchaseTicket(guild, buyerMember, listing) {
  try {
    const existingChannelId = await getActivePurchaseTicket(guild.id, buyerMember.id, listing.id);
    if (existingChannelId) {
      const existingChannel = guild.channels.cache.get(existingChannelId);
      if (existingChannel) {
        return {
          success: false,
          alreadyExists: true,
          channelId: existingChannelId,
        };
      }
      // If channel was deleted from Discord, clear the stale reference
      await deleteFromDb(getBuyerActiveTicketKey(guild.id, buyerMember.id, listing.id));
    }

    const guildConfig = await getGuildConfig(guild.client, guild.id);
    
    // Find or determine category for purchase tickets
    let parentCategory = null;
    if (guildConfig?.ticketCategoryId) {
      parentCategory = guild.channels.cache.get(guildConfig.ticketCategoryId);
    }

    // Channel name formatting (clean lowercase alphanumeric)
    const sanitizedTitle = (listing.title || 'item')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 15);
    const sanitizedBuyer = buyerMember.user.username
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 10);
    const channelName = `buy-${sanitizedTitle}-${sanitizedBuyer}`;

    // Permissions: private channel for buyer, seller, staff, and bot
    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: guild.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: buyerMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: listing.sellerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ];

    // Grant access to staff role if configured in the guild
    if (guildConfig?.ticketStaffRoleId) {
      permissionOverwrites.push({
        id: guildConfig.ticketStaffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: parentCategory?.id || null,
      permissionOverwrites,
      topic: `Purchase Inquiry | Product: ${listing.title} | Buyer: ${buyerMember.user.tag} (${buyerMember.id}) | Seller: <@${listing.sellerId}>`,
    });

    const ticketId = `pt_${ticketChannel.id}`;

    // Welcome embed inside the ticket channel
    const welcomeEmbed = createEmbed({
      title: '🛒 Purchase Inquiry',
      description: `Welcome <@${buyerMember.id}>! You opened a purchase ticket with <@${listing.sellerId}> for **${listing.title}**.\n\nUse this private channel to discuss pricing, delivery, and payment safely.`,
      color: 'success',
      fields: [
        { name: '📦 Product', value: listing.title || 'Untitled', inline: true },
        { name: '💵 Price', value: listing.price ? (listing.price.startsWith('$') ? listing.price : `$${listing.price}`) : 'Contact Seller', inline: true },
        { name: '👤 Seller', value: `<@${listing.sellerId}>`, inline: true },
        { name: '🛍️ Buyer', value: `<@${buyerMember.id}>`, inline: true },
      ],
    });

    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`purchase_ticket_close:${ticketChannel.id}`)
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔒')
    );

    await ticketChannel.send({
      content: `<@${buyerMember.id}> <@${listing.sellerId}>`,
      embeds: [welcomeEmbed],
      components: [controlRow],
    });

    // Save ticket data
    const ticketData = {
      id: ticketId,
      channelId: ticketChannel.id,
      guildId: guild.id,
      listingId: listing.id,
      buyerId: buyerMember.id,
      sellerId: listing.sellerId,
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    await setInDb(getPurchaseTicketKey(guild.id, ticketChannel.id), ticketData);
    await setInDb(getBuyerActiveTicketKey(guild.id, buyerMember.id, listing.id), ticketChannel.id);

    logger.info(`Created purchase ticket channel ${ticketChannel.id} for listing ${listing.id}`);
    return {
      success: true,
      channel: ticketChannel,
    };
  } catch (error) {
    logger.error('Failed to create purchase ticket channel:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Close and delete a purchase ticket.
 */
export async function closePurchaseTicket(interaction, channelId) {
  try {
    const guild = interaction.guild;
    const ticketKey = getPurchaseTicketKey(guild.id, channelId);
    const ticketData = await getFromDb(ticketKey, null);

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      return { success: false, message: 'Ticket channel no longer exists.' };
    }

    // Permission check: buyer, seller, pack seller, or administrator can close
    const isBuyer = ticketData?.buyerId === interaction.user.id;
    const isSeller = ticketData?.sellerId === interaction.user.id;
    const hasAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
    const hasPackSeller = isPackSeller(interaction.member);

    if (!isBuyer && !isSeller && !hasAdmin && !hasPackSeller) {
      return {
        success: false,
        message: 'Only the buyer, seller, or staff can close this purchase ticket.',
      };
    }

    if (ticketData) {
      ticketData.status = 'closed';
      ticketData.closedBy = interaction.user.id;
      ticketData.closedAt = new Date().toISOString();
      await setInDb(ticketKey, ticketData);

      if (ticketData.buyerId && ticketData.listingId) {
        await deleteFromDb(getBuyerActiveTicketKey(guild.id, ticketData.buyerId, ticketData.listingId));
      }
    }

    return { success: true };
  } catch (error) {
    logger.error('Error closing purchase ticket:', error);
    return { success: false, message: error.message };
  }
}
