import { MessageFlags } from 'discord.js';
import { getListing, createPurchaseTicket } from '../../services/marketplaceService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';

export default {
  name: 'purchase_buy',

  async execute(interaction, client, args) {
    const deferred = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferred) return;

    const listingId = args?.[0];
    if (!listingId) {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '❌ Invalid listing data.',
      });
    }

    const listing = await getListing(interaction.guildId, listingId);
    if (!listing || listing.status === 'deleted') {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '❌ This listing is no longer available.',
      });
    }

    if (listing.status === 'paused') {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '⏸️ This listing is temporarily paused by the seller.',
      });
    }

    // Notice: if the user clicking is the seller themselves, inform them
    if (interaction.user.id === listing.sellerId) {
      return await interaction.editReply({
        content: 'ℹ️ You are the seller of this product listing.',
      });
    }

    // Create the independent private purchase ticket
    const result = await createPurchaseTicket(
      interaction.guild,
      interaction.member,
      listing
    );

    if (!result.success) {
      if (result.alreadyExists) {
        return await interaction.editReply({
          content: `ℹ️ You already have an open ticket for **${listing.title}**! Please check <#${result.channelId}>.`,
        });
      }

      logger.error('Failed to create purchase ticket:', result.error);
      return await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: `❌ Failed to create ticket channel: ${result.error || 'Unknown error'}. Please notify staff.`,
      });
    }

    return await interaction.editReply({
      content: `✅ Your private purchase ticket has been created! Head over to <#${result.channel.id}> to speak with <@${listing.sellerId}> and complete your purchase.`,
    });
  },
};
