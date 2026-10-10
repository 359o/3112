import { MessageFlags, AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
import {
  getPurchaseTicketData,
  getListing,
  isPackSeller,
  getPurchaseTicketKey,
} from '../../services/marketplaceService.js';
import { setInDb } from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';

export default {
  name: 'purchase_ticket_handover',

  async execute(interaction, client, args) {
    const deferred = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferred) return;

    const channelId = args?.[0] || interaction.channelId;
    const ticketData = await getPurchaseTicketData(interaction.guildId, channelId);

    if (!ticketData) {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '❌ Could not find ticket data for this channel.',
      });
    }

    // Permission check: only seller of this item, Pack Seller role, or Admin can hand over
    const isSeller = ticketData.sellerId === interaction.user.id;
    const hasPackSeller = isPackSeller(interaction.member);
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isSeller && !hasPackSeller && !isAdmin) {
      return await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: '❌ Only the seller or authorized staff can hand over the product.',
      });
    }

    if (ticketData.delivered) {
      return await interaction.editReply({
        content: 'ℹ️ This product has already been handed over to the buyer in this ticket.',
      });
    }

    const listing = await getListing(interaction.guildId, ticketData.listingId);
    if (!listing) {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '❌ Could not find listing information.',
      });
    }

    const files = [];
    if (listing.productFileUrl) {
      files.push(
        new AttachmentBuilder(listing.productFileUrl, {
          name: listing.productFileName || 'product.zip',
        })
      );
    }

    let deliveryContent = `🎉 **Product Delivered!**\n<@${ticketData.buyerId}>, your order for **${listing.title}** has been handed over by <@${interaction.user.id}>!\n`;

    if (listing.productLink) {
      deliveryContent += `\n🔗 **Download Link:** ${listing.productLink}\n`;
    }

    if (!listing.productFileUrl && !listing.productLink) {
      deliveryContent += `\n*(No file or link was attached during setup; seller will send files directly below)*\n`;
    }

    deliveryContent += '\nThank you for your purchase! Feel free to leave a review.';

    try {
      // Send the product into the ticket channel
      await interaction.channel.send({
        content: deliveryContent,
        files,
      });

      // Mark delivered in DB
      ticketData.delivered = true;
      ticketData.deliveredAt = new Date().toISOString();
      ticketData.deliveredBy = interaction.user.id;
      await setInDb(getPurchaseTicketKey(interaction.guildId, channelId), ticketData);

      logger.info(`Product handed over in ticket channel ${channelId} for listing ${listing.id}`);

      return await interaction.editReply({
        content: '✅ Product successfully handed over to the buyer!',
      });
    } catch (error) {
      logger.error('Error delivering product in ticket:', error);
      return await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: `Failed to deliver product: ${error.message}. You can send the file/link manually in chat.`,
      });
    }
  },
};
