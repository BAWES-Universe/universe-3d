// Synthetic opt-in fixture. Neither source defaults nor observed operator settings.
export const proximityFixture = Object.freeze({enabled:true,
  membershipCeiling:8,p2pThreshold:5,downgradeDelayMs:20000,
  minimumDistanceSource:64,groupRadiusSource:48,sourceUnitsPerWorldUnit:16,
  coordinateLimitWorld:100000,memberTtlMs:60000,maxRooms:8,
  maxMembersPerRoom:100,maxAccounts:200,maxMemberships:400,maxSessionsPerMember:8,
});
