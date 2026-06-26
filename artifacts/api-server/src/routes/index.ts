import { Router, type IRouter } from "express";
import healthRouter from "./health";
import propotatoRouter from "./propotato";

const router: IRouter = Router();

router.use(healthRouter);
router.use(propotatoRouter);

export default router;
