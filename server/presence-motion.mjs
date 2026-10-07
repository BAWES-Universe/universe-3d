import * as v from './validation.mjs';
import {seatPose,canReachSeat} from '../src/worlds.js';

// Presence remains a validated client report, not an anti-cheat physics server.
// Seat targets, occupancy and pose are checked against the admitted room only.
export function readPresenceMotion(body, {scene,previous,presence,userId,roomId,now}) {
 // Older tabs only report x/z. Their new walk must release a newer tab's
 // elevated/seated pose; metadata-only updates leave that pose untouched.
 const legacyPosition=(body.x!==undefined||body.z!==undefined)&&['y','verticalVelocity','grounded','seatId'].every(key=>body[key]===undefined);
 const fields=legacyPosition?{y:0,verticalVelocity:0,grounded:true,seatId:null,seatHeight:0}:{};
 if(body.y!==undefined)fields.y=v.finite(body.y,'y',0,512);
 if(body.verticalVelocity!==undefined)fields.verticalVelocity=v.finite(body.verticalVelocity,'verticalVelocity',-64,12);
 if(body.grounded!==undefined)fields.grounded=v.boolean(body.grounded,'grounded');
 if(body.seatId===undefined)return fields;
 if(body.seatId===null||body.seatId==='')return {...fields,seatId:null,seatHeight:0};
 const seatId=v.id(body.seatId,'seatId'),object=scene.objects.find(item=>item.id===seatId),pose=seatPose(scene,object);
 if(!pose)v.fail(400,'INVALID_SEAT','Choose a chair, bench or sofa in this room');
 if(!previous||!canReachSeat(scene,previous,object))v.fail(409,'SEAT_OUT_OF_REACH','Walk closer to the seat first');
 if([...presence.values()].some(person=>person.userId!==userId&&person.roomId===roomId&&person.seatId===seatId&&now-person.lastSeen<60000))v.fail(409,'SEAT_OCCUPIED','Someone is already sitting there');
 return {...fields,x:pose.x,y:0,z:pose.z,rotation:pose.heading,seatId,seatHeight:pose.seatHeight,moving:false,running:false,velocity:{x:0,z:0},verticalVelocity:0,grounded:true};
}
