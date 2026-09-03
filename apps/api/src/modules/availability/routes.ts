// Availability: what a counter may sell right now, and the manual override. Wave 3 fills this in.
//
// The folder exists now, registered and inert, so the next wave's modules can be built in
// parallel without three agents editing modules/index.ts at once. Registering no route is
// deliberate: nothing in packages/contract's manifest points here yet.
import fp from "fastify-plugin";

export default fp(async () => {}, { name: "module:availability" });
