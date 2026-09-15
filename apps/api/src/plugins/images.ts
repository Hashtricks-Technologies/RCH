import fp from "fastify-plugin";
import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import { createDiskStore, createS3Store, type ImageStore } from "../lib/images.js";

declare module "fastify" { interface FastifyInstance { images: ImageStore } }

/** `store` is supplied by a test that wants to own it; otherwise the config decides. The S3
 *  client takes its credentials from the default chain - on the box that is the instance role
 *  over IMDSv2, on EKS the pod's IRSA role - so no key is ever configured. */
export default fp<{ config: Config; store?: ImageStore }>(async (app, { config, store }) => {
  const images = config.images;
  app.decorate("images", store ?? (images.store === "s3"
    ? createS3Store(new S3Client({ region: images.region }), images.bucket)
    : createDiskStore(images.dir)));
}, { name: "images" });
