import { DependencyContainer, inject, injectable } from "tsyringe";

import { LocationController } from "@spt/controllers/LocationController";
import { HttpResponseUtil } from "@spt/utils/HttpResponseUtil";

import { ApplicationContext } from "@spt/context/ApplicationContext";
import { ContextVariableType } from "@spt/context/ContextVariableType";
import { ProfileHelper } from "@spt/helpers/ProfileHelper";
import { ILocationBase } from "@spt/models/eft/common/ILocationBase";
import { IEndLocalRaidRequestData, ILocationTransit } from "@spt/models/eft/match/IEndLocalRaidRequestData";
import { IStartLocalRaidRequestData } from "@spt/models/eft/match/IStartLocalRaidRequestData";
import { IStartLocalRaidResponseData } from "@spt/models/eft/match/IStartLocalRaidResponseData";
import { BotGenerationCacheService } from "@spt/services/BotGenerationCacheService";
import { DatabaseService } from "@spt/services/DatabaseService";
import { LocationLifecycleService } from "@spt/services/LocationLifecycleService";
import { TimeUtil } from "@spt/utils/TimeUtil";
import { Override } from "../../di/Override";
import { FikaMatchService } from "../../services/FikaMatchService";
import { BotLootCacheService } from "@spt/services/BotLootCacheService";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { IInRaidConfig } from "@spt/models/spt/config/IInRaidConfig";
import { ITraderConfig } from "@spt/models/spt/config/ITraderConfig";
import { IRagfairConfig } from "@spt/models/spt/config/IRagfairConfig";
import { IHideoutConfig } from "@spt/models/spt/config/IHideoutConfig";
import { ILocationConfig } from "@spt/models/spt/config/ILocationConfig";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";

@injectable()
export class LocationLifecycleServiceOverride extends Override {
    constructor(
        @inject("DatabaseService") protected databaseService: DatabaseService,
        @inject("ProfileHelper") protected profileHelper: ProfileHelper,
        @inject("LocationController") protected locationController: LocationController,
        @inject("HttpResponseUtil") protected httpResponseUtil: HttpResponseUtil,
        @inject("FikaMatchService") protected fikaMatchService: FikaMatchService,
        @inject("LocationLifecycleService") protected locationLifecycleService: LocationLifecycleService,
        @inject("BotGenerationCacheService") protected botGenerationCacheService: BotGenerationCacheService,
        @inject("ApplicationContext") protected applicationContext: ApplicationContext,
        @inject("TimeUtil") protected timeUtil: TimeUtil,
        @inject("BotLootCacheService") protected botLootCacheService: BotLootCacheService,
        @inject("PrimaryLogger") protected logger: ILogger,
    ) {
        super();
    }

    public execute(container: DependencyContainer): void {
        container.afterResolution(
            "LocationLifecycleService",
            (_t, result: LocationLifecycleService) => {
                result.startLocalRaid = (sessionId: string, request: IStartLocalRaidRequestData): IStartLocalRaidResponseData => {
                    let locationLoot: ILocationBase;
                    const matchId = this.fikaMatchService.getMatchIdByProfile(sessionId);
                    // Stops TS from throwing a tantrum :)
                    const lifecycleService = (this.locationLifecycleService as any);

                    if (matchId === undefined) {
                        // player isn't in a Fika match, generate new loot
                        locationLoot = lifecycleService.generateLocationAndLoot(request.location);
                    } else {
                        // player is in a Fika match, use match location loot
                        const match = this.fikaMatchService.getMatch(matchId);
                        locationLoot = match.locationData;
                    }

                    const playerProfile = this.profileHelper.getPmcProfile(sessionId);

                    const result: IStartLocalRaidResponseData = {
                        serverId: `${request.location}.${request.playerSide}.${this.timeUtil.getTimestamp()}`,
                        serverSettings: this.databaseService.getLocationServices(),
                        profile: { insuredItems: playerProfile.InsuredItems },
                        locationLoot: locationLoot,
                        transition: {
                            isLocationTransition: false,
                            transitionRaidId: "66f5750951530ca5ae09876d",
                            transitionCount: 0,
                            visitedLocations: [],
                        }
                    };

                    // Only has value when transitioning into map from previous one
                    if (request.transition) {
                        result.transition = request.transition;
                    }

                    // Get data stored at end of previous raid (if any)
                    const transitionData = this.applicationContext
                        .getLatestValue(ContextVariableType.TRANSIT_INFO)
                        ?.getValue<ILocationTransit>();
                    if (transitionData) {
                        result.transition.isLocationTransition = true;
                        result.transition.transitionRaidId = transitionData.transitionRaidId;
                        result.transition.transitionCount += 1;
                        result.transition.visitedLocations.push(transitionData.location); // TODO - check doesnt exist before adding to prevent dupes

                        // Complete, clean up
                        this.applicationContext.clearValues(ContextVariableType.TRANSIT_INFO);
                    }

                    if (typeof matchId === "undefined" || sessionId === matchId) {
                        // Apply changes from pmcConfig to bot hostility values
                        lifecycleService.adjustBotHostilitySettings(result.locationLoot);

                        lifecycleService.adjustExtracts(request.playerSide, request.location, result.locationLoot);

                        // Clear bot cache ready for a fresh raid
                        lifecycleService.botGenerationCacheService.clearStoredBots();
                        lifecycleService.botNameService.clearNameCache();
                    }

                    return result;
                }

                result.endLocalRaid = (sessionId: string, request: IEndLocalRaidRequestData): void => {
                    var isSpectator: boolean = false;

                    // Get match id from player session id
                    const matchId = this.fikaMatchService.getMatchIdByPlayer(sessionId);

                    if(sessionId == matchId)
                    {
                        // Clear bot loot cache only if host ended raid
                        this.botLootCacheService.clearCache();
                    }

                    const match = this.fikaMatchService.getMatch(matchId);

                    // Find player that exited the raid
                    match.players.forEach((player, playerId) => {
                        if(sessionId == playerId) {
                            if(player.isSpectator) {
                                isSpectator = true;
                                return;
                            }
                        }
                    });

                    // Execute original method if not spectator (clear inventory, etc.)
                    if(!isSpectator) {
                        LocationLifecycleService.prototype.endLocalRaid.call(result, sessionId, request);
                    }
                }
            },
            { frequency: "Always" },
        );
    }
}
