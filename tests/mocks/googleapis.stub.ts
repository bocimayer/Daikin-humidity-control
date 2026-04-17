/** Jest stub for googleapis (Gmail send). */

export const gmailSendMock = jest.fn().mockResolvedValue({ data: {} });

export const google = {
  auth: {
    OAuth2: jest.fn().mockImplementation(() => ({
      setCredentials: jest.fn(),
    })),
  },
  gmail: jest.fn(() => ({
    users: {
      messages: {
        send: gmailSendMock,
      },
    },
  })),
};
