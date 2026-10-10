import {
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { isPackSeller, saveListing } from '../../services/marketplaceService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('purchase-setup')
    .setDescription('Create and post a new product selling listing (Pack Sellers only)')
    .addAttachmentOption((option) =>
      option
        .setName('video')
        .setDescription('Upload the product showcase video')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('title')
        .setDescription('The title or name of the pack/product (e.g. Pink Wave)')
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption((option) =>
      option
        .setName('price')
        .setDescription('The price of the item (e.g. $10)')
        .setRequired(false)
        .setMaxLength(50)
    )
    .addStringOption((option) =>
      option
        .setName('description')
        .setDescription('Optional extra details or description')
        .setRequired(false)
        .setMaxLength(500)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('The channel to post the listing in (defaults to current channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),

  category: 'Marketplace',

  async execute(interaction, guildConfig, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferred) return;

    // Check seller permissions: must have Pack Seller role or Admin
    if (!isPackSeller(interaction.member)) {
      return await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: '❌ You must have the **Pack Seller** role to create marketplace listings.',
      });
    }

    const videoAttachment = interaction.options.getAttachment('video');
    const title = interaction.options.getString('title').trim();
    const rawPrice = interaction.options.getString('price')?.trim();
    const description = interaction.options.getString('description')?.trim();
    const targetChannel =
      interaction.options.getChannel('channel') || interaction.channel;

    // Validate that the attachment is a video
    const isVideo =
      videoAttachment?.contentType?.startsWith('video/') ||
      /\.(mp4|mov|webm|mkv|avi)$/i.test(videoAttachment?.name || '');

    if (!isVideo) {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: '❌ The uploaded file must be a valid video file (.mp4, .mov, .webm, etc.).',
      });
    }

    // Format price if provided
    let formattedPrice = null;
    if (rawPrice) {
      formattedPrice = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`;
    }

    // Generate unique listing identifier
    const uniqueSuffix = Math.random().toString(36).substring(2, 7);
    const listingId = `pack_${Date.now().toString(36)}_${uniqueSuffix}`;

    // Construct the message text exactly matching the screenshot reference:
    // **Title**
    // Price: $10
    // Seller: @user
    let messageContent = `**${title}**\n`;
    if (formattedPrice) {
      messageContent += `Price: ${formattedPrice}\n`;
    }
    if (description) {
      messageContent += `${description}\n`;
    }
    messageContent += `Seller: <@${interaction.user.id}>`;

    // Construct the green Purchase button underneath the video
    const purchaseRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`purchase_buy:${listingId}`)
        .setLabel('Purchase')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🛒')
    );

    try {
      // Send the post to the designated channel with the video attached
      const sentMessage = await targetChannel.send({
        content: messageContent,
        files: [videoAttachment.url],
        components: [purchaseRow],
      });

      // Save listing to persistent database
      const listingData = {
        id: listingId,
        guildId: interaction.guildId,
        channelId: targetChannel.id,
        messageId: sentMessage.id,
        messageUrl: sentMessage.url,
        sellerId: interaction.user.id,
        sellerTag: interaction.user.tag,
        title,
        price: formattedPrice,
        description: description || null,
        videoUrl: videoAttachment.url,
        status: 'active',
        createdAt: new Date().toISOString(),
      };

      await saveListing(interaction.guildId, listingData);

      logger.info(`Posted marketplace listing ${listingId} in #${targetChannel.name} by ${interaction.user.tag}`);

      return await interaction.editReply({
        content: `✅ Successfully created and published your listing for **${title}** in <#${targetChannel.id}>!\n🔗 [Jump to Listing](${sentMessage.url})\n\n**Listing ID:** \`${listingId}\``,
      });
    } catch (error) {
      logger.error('Failed to post marketplace listing message:', error);
      return await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: `Failed to post listing in <#${targetChannel.id}>: ${error.message}. Please ensure the bot has permission to send messages and attachments in that channel.`,
      });
    }
  },
};
