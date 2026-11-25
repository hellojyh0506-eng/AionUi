/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

type FeedbackButtonProps = {
  /** Pre-selects the module in the feedback modal (see FEEDBACK_MODULES tags). */
  module?: string;
  /** Extra Sentry tags attached to the feedback event. */
  feedbackTags?: Record<string, string>;
  /** Extra structured context attached to the feedback event. */
  feedbackExtra?: Record<string, unknown>;
  /** Additional classes appended to the default pill styling. */
  className?: string;
};

const FeedbackButton: React.FC<FeedbackButtonProps> = () => {
  // Feedback entry is temporarily hidden until self-hosted / Gmail support is wired.
  return null;
};

export default FeedbackButton;
