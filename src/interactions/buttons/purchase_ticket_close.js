import { MessageFlags } from 'discord.js';
import { closePurchaseTicket } from '../../services/marketplaceService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';

export default {
  name: 'purchase_ticket_close',

  async execute(interaction, client, args) {
    const channelId = args?.[0] || interaction.channelId;

    const result = await closePurchaseTicket(interaction, channelId);

    if (!result.success) {
      return await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: `❌ ${result.message || 'You cannot close this ticket.'}`,
      });
    }

    await interaction.reply({
      content: `🔒 Purchase ticket closed by <@${interaction.user.id}>. This channel will be deleted in **5 seconds**...`,
    });

    const channel = interaction.guild.channels.cache.get(channelId);
    if (channel) {
      setTimeout(async () => {
        try {
          await channel.delete('Purchase ticket closed');
        } catch (err) {
          logger.warn(`Could not delete purchase ticket channel ${channelId}:`, err);
        }
      }, 5000);
    }
  },
};
