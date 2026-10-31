// Site files in S3. Each version lives under its own immutable prefix,
// <site-id>/<version-id>/<path>, so it can be cached forever and switching the
// current version never needs an invalidation. Uploads go to a separate bucket
// that expires objects on its own.
//
// GuardDuty scans only the uploads bucket. New content for a version is
// written there first, under inline/<site-id>/<version-id>/<path>, then copied
// to the sites bucket, so every new file is scanned once and the copies of
// unchanged files an update makes are never scanned again.
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type Buckets = { sites: string; uploads: string };

const IMMUTABLE = 'public, max-age=31536000, immutable';

// The tag GuardDuty Malware Protection for S3 puts on each object it scans.
export const SCAN_STATUS_TAG = 'GuardDutyMalwareScanStatus';
export const NO_THREATS = 'NO_THREATS_FOUND';
export const THREATS = 'THREATS_FOUND';

// Where new version files are staged for scanning, in the uploads bucket.
// Upload IDs can't contain "/", so this never collides with an upload.
export const STAGED_PREFIX = 'inline/';

function bytes(body: { transformToByteArray(): Promise<Uint8Array> } | undefined): Promise<Uint8Array> {
  if (!body) throw new Error('S3 returned no body');
  return body.transformToByteArray();
}

export class SiteFiles {
  readonly #s3: S3Client;
  readonly #buckets: Buckets;

  constructor(s3: S3Client, buckets: Buckets) {
    this.#s3 = s3;
    this.#buckets = buckets;
  }

  // Stages the file for scanning, then copies it into place. The staged copy
  // stays until the uploads bucket expires it, so the scan can finish.
  async putVersionFile(siteId: string, versionId: string, path: string, body: Uint8Array, contentType: string): Promise<void> {
    const staged = `${STAGED_PREFIX}${siteId}/${versionId}/${path}`;
    await this.#s3.send(new PutObjectCommand({
      Bucket: this.#buckets.uploads,
      Key: staged,
      Body: body,
      ContentType: contentType,
      CacheControl: IMMUTABLE,
    }));
    // The scan result tag isn't carried over: the sites bucket isn't scanned.
    await this.#s3.send(new CopyObjectCommand({
      Bucket: this.#buckets.sites,
      Key: `${siteId}/${versionId}/${path}`,
      CopySource: encodeURI(`${this.#buckets.uploads}/${staged}`),
      TaggingDirective: 'REPLACE',
    }));
  }

  // Carries an unchanged file into a new version. S3 copies the content type
  // and cache headers with it.
  async copyVersionFile(siteId: string, fromVersionId: string, toVersionId: string, path: string): Promise<void> {
    await this.#s3.send(new CopyObjectCommand({
      Bucket: this.#buckets.sites,
      Key: `${siteId}/${toVersionId}/${path}`,
      CopySource: encodeURI(`${this.#buckets.sites}/${siteId}/${fromVersionId}/${path}`),
    }));
  }

  async getVersionFile(siteId: string, versionId: string, path: string): Promise<Uint8Array> {
    const { Body } = await this.#s3.send(new GetObjectCommand({ Bucket: this.#buckets.sites, Key: `${siteId}/${versionId}/${path}` }));
    return bytes(Body);
  }

  presignVersionFile(siteId: string, versionId: string, path: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.#s3, new GetObjectCommand({ Bucket: this.#buckets.sites, Key: `${siteId}/${versionId}/${path}` }), { expiresIn });
  }

  // The URL only accepts a body of exactly the declared size.
  presignUpload(uploadId: string, path: string, size: number, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.#s3,
      new PutObjectCommand({ Bucket: this.#buckets.uploads, Key: `${uploadId}/${path}`, ContentLength: size }),
      { expiresIn, signableHeaders: new Set(['content-length']) },
    );
  }

  // Returns undefined when the file wasn't uploaded.
  async uploadedSize(uploadId: string, path: string): Promise<number | undefined> {
    try {
      const { ContentLength } = await this.#s3.send(new HeadObjectCommand({ Bucket: this.#buckets.uploads, Key: `${uploadId}/${path}` }));
      return ContentLength;
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return undefined;
      throw err;
    }
  }

  async getUploadedFile(uploadId: string, path: string): Promise<Uint8Array> {
    const { Body } = await this.#s3.send(new GetObjectCommand({ Bucket: this.#buckets.uploads, Key: `${uploadId}/${path}` }));
    return bytes(Body);
  }

  // GuardDuty Malware Protection's result for an uploaded file, from the tag
  // it adds once the scan is done; undefined while it's still scanning.
  async uploadScanStatus(uploadId: string, path: string): Promise<string | undefined> {
    const { TagSet = [] } = await this.#s3.send(new GetObjectTaggingCommand({ Bucket: this.#buckets.uploads, Key: `${uploadId}/${path}` }));
    return TagSet.find((tag) => tag.Key === SCAN_STATUS_TAG)?.Value;
  }

  deleteUpload(uploadId: string): Promise<void> {
    return this.#deletePrefix(this.#buckets.uploads, `${uploadId}/`);
  }

  deleteSite(siteId: string): Promise<void> {
    return this.#deletePrefix(this.#buckets.sites, `${siteId}/`);
  }

  async #deletePrefix(bucket: string, prefix: string): Promise<void> {
    let ContinuationToken: string | undefined;
    do {
      const page = await this.#s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
      const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }));
      if (objects.length) {
        await this.#s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      }
      ContinuationToken = page.NextContinuationToken;
    } while (ContinuationToken);
  }
}
