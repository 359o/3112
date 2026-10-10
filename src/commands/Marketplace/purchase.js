import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  isPackSeller,
  getListingsBySeller,
  getAllListings,
  getListing,
  saveListing,
  deleteListing,
} from '../../services/marketplaceService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('purchase')
    .setDescription('Manage marketplace product listings')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('View your active marketplace product listings')
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a marketplace product listing')
        .addStringOption((opt) =>
          opt
            .setName('listing_id')
            .setDescription('The ID of the listing to delete')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('pause')
        .setDescription('Temporarily pause purchasing on a listing')
        .addStringOption((opt) =>
          opt
            .setName('listing_id')
            .setDescription('The ID of the listing to pause')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('resume')
        .setDescription('Re-enable purchasing on a paused listing')
        .addStringOption((opt) =>
          opt
            .setName('listing_id')
            .setDescription('The ID of the listing to resume')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Edit the title, price, or description of a listing')
        .addStringOption((opt) =>
          opt
            .setName('listing_id')
            .setDescription('The ID of the listing to edit')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('new_title')
            .setDescription('New title for the pack/product')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('new_price')
            .setDescription('New price (e.g. $15)')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('new_description')
            .setDescription('New description or info')
            .setRequired(false)
        )
    ),

  category: 'Marketplace',

  async execute(interaction, guildConfig, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferred) return;

    if (!isPackSeller(interaction.member)) {
      return await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: '❌ You must have the **Pack Seller** role to manage marketplace listings.',
      });
    }

    const subcommand = interaction.options.getSubcommand();
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    // /purchase list
    if (subcommand === 'list') {
      const listings = isAdmin
        ? await getAllListings(interaction.guildId)
        : await getListingsBySeller(interaction.guildId, interaction.user.id);

      if (listings.length === 0) {
        return await interaction.editReply({
          content: 'ℹ️ You currently have no active listings. Create one using `/purchase-setup`!',
        });
      }

      const fields = listings.slice(0, 25).map((item) => ({
        name: `${item.title} (${item.status === 'paused' ? '⏸️ Paused' : '🟢 Active'})`,
        value: `**ID:** \`${item.id}\`\n**Price:** ${item.price || 'None'}\n**Channel:** <#${item.channelId}>\n${item.messageUrl ? `[View Listing](${item.messageUrl})` : ''}`,
        inline: false,
      }));

      const embed = createEmbed({
        title: isAdmin ? '🛒 Server Marketplace Listings' : '🛒 Your Marketplace Listings',
        description: `Found ${listings.length} listing(s). Use \`/purchase delete\` or \`/purchase edit\` with the Listing ID to manage.`,
        fields,
        color: 'primary',
      });

      return await interaction.editReply({ embeds: [embed] });
    }

    const listingId = interaction.options.getString('listing_id').trim();
    const listing = await getListing(interaction.guildId, listingId);

    if (!listing || listing.status === 'deleted') {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: `❌ No active listing found with ID \`${listingId}\`.`,
      });
    }

    // Permission check: only the seller who created it or an admin can manage it
    if (listing.sellerId !== interaction.user.id && !isAdmin) {
      return await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: '❌ You can only manage your own listings.',
      });
    }

    // /purchase delete
    if (subcommand === 'delete') {
      try {
        const channel = interaction.guild.channels.cache.get(listing.channelId);
        if (channel && listing.messageId) {
          const msg = await channel.messages.fetch(listing.messageId).catch(() => null);
          if (msg) {
            await msg.delete().catch(() => {});
          }
        }
      } catch (err) {
        logger.warn(`Could not delete Discord message for listing ${listingId}:`, err);
      }

      await deleteListing(interaction.guildId, listingId);
      return await interaction.editReply({
        content: `🗑️ Successfully deleted listing **${listing.title}** (\`${listingId}\`).`,
      });
    }

    // /purchase pause
    if (subcommand === 'pause') {
      listing.status = 'paused';
      await saveListing(interaction.guildId, listing);

      // Disable button on discord message
      try {
        const channel = interaction.guild.channels.cache.get(listing.channelId);
        if (channel && listing.messageId) {
          const msg = await channel.messages.fetch(listing.messageId).catch(() => null);
          if (msg) {
            const pausedRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`purchase_buy:${listing.id}`)
                .setLabel('Paused')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⏸️')
                .setDisabled(true)
            );
            await msg.edit({ components: [pausedRow] }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn(`Could not update message for paused listing ${listingId}:`, err);
      }

      return await interaction.editReply({
        content: `⏸️ Listing **${listing.title}** is now paused. Users cannot purchase it until you run \`/purchase resume\`.`,
      });
    }

    // /purchase resume
    if (subcommand === 'resume') {
      listing.status = 'active';
      await saveListing(interaction.guildId, listing);

      // Re-enable green purchase button
      try {
        const channel = interaction.guild.channels.cache.get(listing.channelId);
        if (channel && listing.messageId) {
          const msg = await channel.messages.fetch(listing.messageId).catch(() => null);
          if (msg) {
            const activeRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`purchase_buy:${listing.id}`)
                .setLabel('Purchase')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🛒')
            );
            await msg.edit({ components: [activeRow] }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn(`Could not update message for resumed listing ${listingId}:`, err);
      }

      return await interaction.editReply({
        content: `▶️ Listing **${listing.title}** is now active and open for purchases.`,
      });
    }

    // /purchase edit
    if (subcommand === 'edit') {
      const newTitle = interaction.options.getString('new_title');
      const newPrice = interaction.options.getString('new_price');
      const newDesc = interaction.options.getString('new_description');

      if (!newTitle && !newPrice && !newDesc) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: '❌ Please provide at least one option to update (`new_title`, `new_price`, or `new_description`).',
        });
      }

      if (newTitle) listing.title = newTitle.trim();
      if (newPrice) {
        const trimmedPrice = newPrice.trim();
        listing.price = trimmedPrice.startsWith('$') ? trimmedPrice : `$${trimmedPrice}`;
      }
      if (newDesc) listing.description = newDesc.trim();

      await saveListing(interaction.guildId, listing);

      // Update the Discord message text
      try {
        const channel = interaction.guild.channels.cache.get(listing.channelId);
        if (channel && listing.messageId) {
          const msg = await channel.messages.fetch(listing.messageId).catch(() => null);
          if (msg) {
            let updatedContent = `**${listing.title}**\n`;
            if (listing.price) updatedContent += `Price: ${listing.price}\n`;
            if (listing.description) updatedContent += `${listing.description}\n`;
            updatedContent += `Seller: <@${listing.sellerId}>`;

            await msg.edit({ content: updatedContent }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn(`Could not update message for edited listing ${listingId}:`, err);
      }

      return await interaction.editReply({
        content: `✏️ Successfully updated listing **${listing.title}** (\`${listingId}\`).`,
      });
    }
  },
};
